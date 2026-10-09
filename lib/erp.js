/* ==========================================================================
   Equitas Business Suite — zero-dependency ERP · CRM · POS for a law firm
   --------------------------------------------------------------------------
   Built entirely on the EquitasDB NoSQL engine. No npm packages. It models
   the day-to-day commercial operations of a Kenyan advocates' practice and
   is engineered around the following Kenyan statutes and rules:

     • VAT Act, 2013 (No. 35 of 2013) — 16% standard-rated supplies, tax
       invoices, credit notes and the VAT return summary.
     • Tax Procedures Act, 2015 & Finance Act — eTIMS electronic tax invoice
       payloads and KRA PIN capture.
     • Income Tax Act (Cap. 470) — withholding tax on professional fees.
     • Advocates Act (Cap. 16) & Advocates (Accounts) Rules — a client
       (trust) account kept separate from the office account. Client money
       may never fund office expenses and the account may never be overdrawn.
     • Advocates (Remuneration) Order — billable fee scales (configurable).
     • Proceeds of Crime and Anti-Money Laundering Act, 2009 (as amended) —
       client due diligence / KYC, beneficial ownership, PEP and risk rating.
     • Data Protection Act, 2019 — retention periods and data minimisation.
     • Companies Act, 2015 — company registration particulars on KYC.
   ========================================================================== */
"use strict";

const crypto = require("crypto");

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const pad = (n, width) => String(n).padStart(width, "0");
const todayISO = () => new Date().toISOString().slice(0, 10);
const YEAR = () => new Date().getFullYear();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PIN_RE = /^[A-Za-z]{1}[0-9]{9}[A-Za-z]{1}$/; // KRA PIN: letter + 9 digits + letter

/** Default configuration — override via `new ERP(db, { config })` or setConfig. */
const DEFAULT_CONFIG = {
  currency: "KES",
  vatRegistered: true,
  vatRate: 0.16, // VAT Act 2013, s.5(1)
  whtResidentRate: 0.05, // Income Tax Act — professional fees, residents
  whtNonResidentRate: 0.2, // professional fees, non-residents
  retentionYears: 7, // AML / professional record-keeping
  prefixes: { matter: "EQ", invoice: "EQ-INV", receipt: "EQ-RCT", credit: "EQ-CRN" },
  seller: {
    name: "Equitas Law Advocates",
    pin: "P051234567X", // replace with the firm's KRA PIN
    address: "Equitas House, 5th Floor, Kenyatta Avenue, Nairobi",
    email: "accounts@equitaslaw.co.ke",
    phone: "+254 711 000 222",
  },
  trustBank: { name: "", branch: "", account: "" },
  // eTIMS is mandatory for VAT-registered persons (Finance Act 2023).
  // `transmit` is a local placeholder; wire a real KRA/VSCU call in production.
  eTims: { enabled: true, intermediary: "KRA", deviceId: "EQUITAS-SCU-0001", login: null },
  // Advocates (Remuneration) Order scales. These are ILLUSTRATIVE brackets and
  // MUST be reconciled with the current Order before billing. value = upper
  // bound of the bracket (null = infinity); rate = fraction; min/plus style is
  // applied as a straight percentage of the whole consideration.
  feeScales: {
    conveyancing: [
      { upTo: 500000, rate: 0.03 },
      { upTo: 1000000, rate: 0.025 },
      { upTo: 5000000, rate: 0.02 },
      { upTo: 10000000, rate: 0.015 },
      { upTo: null, rate: 0.0125 },
    ],
  },
};

class ERPError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "ERPError";
    this.status = status;
  }
}

class ERP {
  constructor(db, options = {}) {
    this.db = db;
    this.config = Object.assign({}, DEFAULT_CONFIG, options.config || {});
    this._receivedBy = options.receivedBy || "system";
    this._transmitHook =
      (this.config.eTims && this.config.eTims.transmit) ||
      (options.transmit) ||
      null;

    // Collections
    this.clients = db.collection("clients");
    this.matters = db.collection("matters");
    this.timeEntries = db.collection("timeEntries");
    this.invoices = db.collection("invoices");
    this.payments = db.collection("payments");
    this.trust = db.collection("trustTransactions");
    this.office = db.collection("officeTransactions");
    this.expenses = db.collection("expenses");
    this.mpesa = db.collection("mpesaTransactions");
    this.audit = db.collection("auditLog");
    this.counters = db.collection("counters");

    const indexed = [
      [this.clients, "email"],
      [this.matters, "clientId"],
      [this.matters, "matterNumber"],
      [this.timeEntries, "matterId"],
      [this.invoices, "clientId"],
      [this.invoices, "invoiceNumber", { unique: true }],
      [this.payments, "clientId"],
      [this.payments, "invoiceId"],
      [this.payments, "receiptNumber", { unique: true }],
      [this.mpesa, "receipt", { unique: true }],
      [this.mpesa, "checkoutRequestId"],
      [this.trust, "clientId"],
    ];
    for (const [col, field, opts] of indexed) {
      try {
        col.createIndex(field, opts || {});
      } catch (_) {
        /* index already present on a warm collection */
      }
    }
  }

  setConfig(patch) {
    this.config = Object.assign({}, this.config, patch || {});
    return this.config;
  }

  /* ----------------------------- utilities ------------------------------ */

  _audit(action, entity, entityId, details = {}) {
    return this.audit.insert({
      at: new Date().toISOString(),
      action,
      entity,
      entityId: entityId || null,
      actor: details.actor || this._receivedBy,
      details,
    });
  }

  _nextSeq(key) {
    const existing = this.counters.findOne({ _id: key });
    const seq = (existing ? existing.seq : 0) + 1;
    if (existing) this.counters.update(key, { $set: { seq } });
    else this.counters.insert({ _id: key, seq });
    return seq;
  }

  _number(kind, year = YEAR(), width = 5) {
    const prefix = this.config.prefixes[kind] || kind.toUpperCase();
    const seq = this._nextSeq(`${kind}:${year}`);
    return `${prefix}-${year}-${pad(seq, width)}`;
  }

  /** M-Pesa style reference helper (payload-free). */
  _reference(prefix) {
    return `${prefix}${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  }

  _require(condition, message, status = 422) {
    if (!condition) throw new ERPError(message, status);
  }

  /* ================================ CRM ================================= */

  _normaliseClient(input, { partial = false } = {}) {
    const out = {};
    const take = (key) => input[key] !== undefined;
    if (take("name")) out.name = String(input.name).trim();
    if (take("type")) out.type = input.type === "company" ? "company" : "individual";
    if (take("email")) out.email = String(input.email || "").trim().toLowerCase();
    if (take("phone")) out.phone = String(input.phone || "").trim();
    if (take("address")) out.address = String(input.address || "").trim();
    if (take("pin")) out.pin = String(input.pin || "").trim().toUpperCase();
    if (take("idNumber")) out.idNumber = String(input.idNumber || "").trim();
    if (take("registrationNumber"))
      out.registrationNumber = String(input.registrationNumber || "").trim();
    if (take("beneficialOwners"))
      out.beneficialOwners = Array.isArray(input.beneficialOwners)
        ? input.beneficialOwners
        : [];
    if (take("pep")) out.pep = !!input.pep;
    if (take("sourceOfFunds")) out.sourceOfFunds = String(input.sourceOfFunds || "").trim();
    if (take("riskRating"))
      out.riskRating = ["low", "medium", "high"].includes(input.riskRating)
        ? input.riskRating
        : "low";
    if (take("status")) out.status = input.status === "inactive" ? "inactive" : "active";
    if (take("notes")) out.notes = String(input.notes || "");
    if (take("tags")) out.tags = Array.isArray(input.tags) ? input.tags : [];

    if (!partial) {
      this._require(out.name, "Client name is required.");
      if (out.email) this._require(EMAIL_RE.test(out.email), "Client email is invalid.");
      if (out.pin) this._require(PIN_RE.test(out.pin), "KRA PIN must be letter + 9 digits + letter.");
      out.type = out.type || "individual";
      out.riskRating = out.riskRating || "low";
      out.pep = out.pep || false;
      out.status = out.status || "active";
      out.beneficialOwners = out.beneficialOwners || [];
      out.kycStatus = "pending";
      out.kycDocuments = [];
    }
    return out;
  }

  /** Derived AML risk score (POCAMLA). PEP and company structures raise risk. */
  assessRisk(client) {
    let score = 0;
    if (client.pep) score += 3;
    if (client.type === "company") score += 1;
    if ((client.beneficialOwners || []).length > 0) score += 1;
    if (!client.pin) score += 1;
    if (client.sourceOfFunds) score -= 1;
    const rating = score >= 4 ? "high" : score >= 2 ? "medium" : "low";
    return { score, rating };
  }

  createClient(input) {
    const data = this._normaliseClient(input);
    if (data.email) {
      const dupe = this.clients.findOne({ email: data.email });
      this._require(!dupe, "A client with this email already exists.", 409);
    }
    data.riskAssessment = this.assessRisk(data);
    const created = this.clients.insert(data);
    this._audit("client.create", "client", created._id, { name: created.name });
    return created;
  }

  updateClient(id, patch) {
    this._require(this.clients.findById(id), "Client not found.", 404);
    const data = this._normaliseClient(patch, { partial: true });
    if (data.email) {
      const dupe = this.clients.findOne({ email: data.email });
      this._require(!dupe || dupe._id === id, "Another client uses this email.", 409);
    }
    this.clients.update(id, { $set: data });
    const updated = this.clients.findById(id);
    this.clients.update(id, { $set: { riskAssessment: this.assessRisk(updated) } });
    this._audit("client.update", "client", id, { fields: Object.keys(data) });
    return this.clients.findById(id);
  }

  getClient(id) {
    return this.clients.findById(id);
  }

  listClients(query = {}, options = {}) {
    return this.clients.find(query, { sort: options.sort || { name: 1 }, limit: options.limit || 500 });
  }

  /** Complete KYC — record verified identity documents (POCAMLA s.45). */
  verifyKyc(id, { status = "verified", documents = [], verifiedBy } = {}) {
    const client = this.clients.findById(id);
    this._require(client, "Client not found.", 404);
    this._require(["verified", "rejected", "pending"].includes(status), "Invalid KYC status.");
    const docs = (Array.isArray(documents) ? documents : []).map((d) => ({
      name: String(d.name || "document"),
      reference: String(d.reference || ""),
      issuedAt: d.issuedAt || null,
      recordedAt: new Date().toISOString(),
    }));
    const result = this.clients.update(id, {
      $set: {
        kycStatus: status,
        kycVerifiedAt: new Date().toISOString(),
        kycVerifiedBy: verifiedBy || this._receivedBy,
        kycDocuments: [...(client.kycDocuments || []), ...docs],
      },
    });
    this._audit("client.kyc", "client", id, { status, documents: docs.length });
    return this.clients.findById(id) || result;
  }

  /** Idempotently turn a website consultation into a CRM record. */
  createClientFromConsultation(c) {
    if (!c) return null;
    const email = String(c.email || "").toLowerCase();
    if (email) {
      const existing = this.clients.findOne({ email });
      if (existing) return existing;
    }
    try {
      return this.createClient({
        name: c.name || "Website enquiry",
        email,
        phone: c.phone || "",
        type: "individual",
        notes: `Source: website consultation${c.service ? " — " + c.service : ""}`,
        tags: ["website-enquiry"],
      });
    } catch (_) {
      return null;
    }
  }

  /* ============================== Matters =============================== */

  openMatter(input = {}) {
    this._require(input.clientId, "A client is required to open a matter.");
    this._require(this.clients.findById(input.clientId), "Client not found.", 404);
    const year = YEAR();
    const seq = this._nextSeq(`matter:${year}`);
    const matterNumber = `${this.config.prefixes.matter}/${year}/${pad(seq, 4)}`;
    const matter = this.matters.insert({
      matterNumber,
      clientId: input.clientId,
      title: String(input.title || "Untitled matter").trim(),
      practiceArea: String(input.practiceArea || "General"),
      advocate: String(input.advocate || this._receivedBy),
      status: "open",
      feeArrangement: ["hourly", "fixed", "retainer", "contingency"].includes(input.feeArrangement)
        ? input.feeArrangement
        : "hourly",
      feeCap: input.feeCap != null ? Number(input.feeCap) : null,
      retainer: input.retainer != null ? round2(input.retainer) : null,
      description: String(input.description || ""),
      openedAt: new Date().toISOString(),
      closedAt: null,
      outcome: null,
    });
    this._audit("matter.open", "matter", matter._id, { matterNumber });
    return matter;
  }

  updateMatter(id, patch = {}) {
    this._require(this.matters.findById(id), "Matter not found.", 404);
    const allowed = {};
    for (const key of ["title", "practiceArea", "advocate", "feeArrangement", "description"]) {
      if (patch[key] !== undefined) allowed[key] = patch[key];
    }
    if (patch.feeCap !== undefined) allowed.feeCap = patch.feeCap == null ? null : Number(patch.feeCap);
    if (patch.status && ["open", "on-hold", "closed"].includes(patch.status)) {
      allowed.status = patch.status;
      if (patch.status === "closed") allowed.closedAt = new Date().toISOString();
    }
    if (patch.outcome !== undefined) allowed.outcome = String(patch.outcome);
    this.matters.update(id, { $set: allowed });
    this._audit("matter.update", "matter", id, { fields: Object.keys(allowed) });
    return this.matters.findById(id);
  }

  getMatter(id) {
    const matter = this.matters.findById(id);
    if (!matter) return null;
    return {
      ...matter,
      client: this.clients.findById(matter.clientId),
      timeTotal: this.timeEntries
        .find({ matterId: id })
        .reduce((sum, t) => sum + (t.amount || 0), 0),
    };
  }

  listMatters(query = {}, options = {}) {
    return this.matters.find(query, { sort: options.sort || { openedAt: -1 }, limit: options.limit || 500 });
  }

  /* ============================== Time ================================= */

  logTime(input = {}) {
    this._require(input.matterId, "A matter is required.");
    const matter = this.matters.findById(input.matterId);
    this._require(matter, "Matter not found.", 404);
    const minutes = Math.max(0, Math.round(Number(input.minutes) || 0));
    const rate = Number(input.rate) || 0;
    const entry = this.timeEntries.insert({
      matterId: input.matterId,
      clientId: matter.clientId,
      advocate: String(input.advocate || matter.advocate || this._receivedBy),
      date: input.date || todayISO(),
      minutes,
      hours: round2(minutes / 60),
      rate,
      amount: round2((minutes / 60) * rate),
      activity: String(input.activity || "Legal services"),
      narrative: String(input.narrative || ""),
      billable: input.billable !== false,
      invoiced: false,
      invoiceId: null,
    });
    this._audit("time.log", "timeEntry", entry._id, {
      matter: matter.matterNumber,
      minutes,
      amount: entry.amount,
    });
    return entry;
  }

  listTime(query = {}, options = {}) {
    return this.timeEntries.find(query, { sort: options.sort || { date: -1 }, limit: options.limit || 1000 });
  }

  unbilledTime(matterId) {
    return this.timeEntries.find({ matterId, billable: true, invoiced: false });
  }

  /* ========================== Tax & invoicing ========================== */

  _lineTotals(lines) {
    const norm = (Array.isArray(lines) ? lines : []).map((l) => {
      const quantity = Number(l.quantity != null ? l.quantity : 1) || 0;
      const unitPrice = Number(l.unitPrice) || 0;
      const vatCode = ["standard", "zero", "exempt"].includes(l.vatCode) ? l.vatCode : "standard";
      const base = round2(quantity * unitPrice);
      const vatAmount = vatCode === "standard" && this.config.vatRegistered
        ? round2(base * this.config.vatRate)
        : 0;
      return {
        description: String(l.description || "Legal services"),
        quantity,
        unitPrice: round2(unitPrice),
        vatCode,
        base,
        vatAmount,
        amount: round2(base + vatAmount),
        timeEntryId: l.timeEntryId || null,
      };
    });
    const subtotal = round2(norm.reduce((s, l) => s + l.base, 0));
    const vatTotal = round2(norm.reduce((s, l) => s + l.vatAmount, 0));
    const total = round2(subtotal + vatTotal);
    return { lines: norm, subtotal, vatTotal, total };
  }

  /**
   * Create an invoice (draft). `clientType` "company"/"individual" and
   * `clientNonResident` decide the default WHT treatment.
   */
  createInvoice(input = {}) {
    this._require(input.clientId, "A client is required.");
    const client = this.clients.findById(input.clientId);
    this._require(client, "Client not found.", 404);
    const { lines, subtotal, vatTotal, total } = this._lineTotals(input.lines);

    let whtRate = 0;
    if (input.whtRate != null) whtRate = Number(input.whtRate);
    else if (input.applyWht || client.type === "company") {
      whtRate = input.clientNonResident
        ? this.config.whtNonResidentRate
        : this.config.whtResidentRate;
    }
    const whtAmount = round2(subtotal * whtRate);
    const netReceivable = round2(total - whtAmount);

    const matterId = input.matterId || null;
    const invoice = this.invoices.insert({
      invoiceNumber: null, // assigned on issue
      status: "draft",
      clientId: input.clientId,
      matterId,
      date: input.date || todayISO(),
      dueDate: input.dueDate || this._addDays(input.date || todayISO(), input.dueDays != null ? input.dueDays : 30),
      currency: this.config.currency,
      lines,
      subtotal,
      vatTotal,
      vatRate: this.config.vatRegistered ? this.config.vatRate : 0,
      total,
      whtRate,
      whtAmount,
      netReceivable,
      amountPaid: 0,
      balance: total,
      creditNotes: [],
      etims: { status: "not-submitted", controlCode: null, submittedAt: null },
      issuedAt: null,
      notes: String(input.notes || ""),
      timeEntryIds: (input.timeEntryIds || []).slice(),
    });
    this._audit("invoice.create", "invoice", invoice._id, { total, clientId: input.clientId });
    return invoice;
  }

  _addDays(dateStr, days) {
    const d = new Date(dateStr + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + Number(days) || 0);
    return d.toISOString().slice(0, 10);
  }

  /** Build an invoice from unbilled time entries on a matter. */
  createInvoiceFromTime(matterId, input = {}) {
    const matter = this.matters.findById(matterId);
    this._require(matter, "Matter not found.", 404);
    const entries = this.unbilledTime(matterId);
    this._require(entries.length, "No unbilled time entries on this matter.", 409);
    const lines = entries.map((e) => ({
      description: `${e.date} — ${e.activity}${e.narrative ? " (" + e.narrative + ")" : ""}`,
      quantity: e.hours,
      unitPrice: e.rate,
      vatCode: "standard",
      timeEntryId: e._id,
    }));
    return this.createInvoice({
      clientId: matter.clientId,
      matterId,
      lines,
      notes: input.notes,
      dueDays: input.dueDays,
      applyWht: input.applyWht,
      timeEntryIds: entries.map((e) => e._id),
    });
  }

  /** Issue a draft invoice: assign its eTIMS-compliant number and payload. */
  issueInvoice(id) {
    const invoice = this.invoices.findById(id);
    this._require(invoice, "Invoice not found.", 404);
    this._require(invoice.status === "draft", "Only draft invoices can be issued.", 409);
    const invoiceNumber = this._number("invoice", Number(invoice.date.slice(0, 4)));
    this.invoices.update(id, {
      $set: { invoiceNumber, status: "issued", issuedAt: new Date().toISOString() },
    });
    // Mark linked time entries as invoiced.
    for (const teId of invoice.timeEntryIds || []) {
      this.timeEntries.update(teId, { $set: { invoiced: true, invoiceId: id } });
    }
    const issued = this.invoices.findById(id);
    if (this.config.eTims && this.config.eTims.enabled) this.transmitInvoice(id);
    this._audit("invoice.issue", "invoice", id, { invoiceNumber });
    return this.invoices.findById(id);
  }

  voidInvoice(id, { reason } = {}) {
    const invoice = this.invoices.findById(id);
    this._require(invoice, "Invoice not found.", 404);
    this._require(invoice.status !== "paid", "A paid invoice cannot be voided — issue a credit note.", 409);
    this.invoices.update(id, { $set: { status: "void", voidReason: String(reason || "") } });
    this._audit("invoice.void", "invoice", id, { reason });
    return this.invoices.findById(id);
  }

  getInvoice(id) {
    const invoice = this.invoices.findById(id);
    if (!invoice) return null;
    return {
      ...invoice,
      client: this.clients.findById(invoice.clientId),
      payments: this.payments.find({ invoiceId: id }),
    };
  }

  listInvoices(query = {}, options = {}) {
    return this.invoices.find(query, { sort: options.sort || { createdAt: -1 }, limit: options.limit || 500 });
  }

  /* ================================ POS ================================ */

  /**
   * Record a payment / receipt. With an invoiceId this settles an invoice;
   * without one it is a counter sale and a fully-paid invoice is raised
   * automatically so that a valid eTIMS tax invoice always exists.
   */
  recordPayment(input = {}) {
    const method = ["cash", "mpesa", "card", "cheque", "bank", "trust-transfer"].includes(input.method)
      ? input.method
      : "cash";
    let amount = round2(input.amount);
    this._require(amount > 0, "Payment amount must be greater than zero.");

    let invoice = null;
    let clientId = input.clientId || null;

    if (input.invoiceId) {
      invoice = this.invoices.findById(input.invoiceId);
      this._require(invoice, "Invoice not found.", 404);
      this._require(invoice.status !== "void", "Cannot pay a voided invoice.", 409);
      this._require(amount <= round2(invoice.balance) + 0.001, "Payment exceeds the outstanding balance.");
      clientId = invoice.clientId;
    } else {
      this._require(clientId || input.clientName, "A client is required for a counter sale.");
      if (!clientId && input.clientName) {
        const client = this.createClient({
          name: input.clientName,
          email: input.clientEmail || "",
          phone: input.clientPhone || "",
          type: input.clientType || "individual",
        });
        clientId = client._id;
      }
      // Counter sale → raise and issue a paid invoice for the receipt. The
      // amount tendered is VAT-inclusive, so derive the net line total.
      const vatRate = this.config.vatRegistered ? this.config.vatRate : 0;
      const lines = input.lines && input.lines.length
        ? input.lines
        : [{
            description: input.description || "Counter sale",
            quantity: 1,
            unitPrice: round2(amount / (1 + vatRate)),
          }];
      const inv = this.createInvoice({ clientId, lines, notes: "Point-of-sale counter sale" });
      invoice = this.issueInvoice(inv._id);
      invoice = this.invoices.findById(inv._id);
      // The receipt mirrors the tax invoice total exactly.
      amount = round2(invoice.total);
    }

    const receiptNumber = this._number("receipt", YEAR());
    const payment = this.payments.insert({
      receiptNumber,
      type: input.invoiceId ? "invoice-payment" : "counter-sale",
      clientId,
      invoiceId: invoice._id,
      amount,
      method,
      reference: String(input.reference || (method === "mpesa" ? this._reference("QK") : "")),
      date: input.date || todayISO(),
      receivedBy: String(input.receivedBy || this._receivedBy),
      notes: String(input.notes || ""),
      whtAmount: round2(input.whtAmount || 0),
    });

    const amountPaid = round2((invoice.amountPaid || 0) + amount);
    const balance = round2(invoice.total - amountPaid);
    const status = balance <= 0.001 ? "paid" : amountPaid > 0 ? "part-paid" : invoice.status;

    // Rebalance the auto-created counter-sale invoice if the payment differs.
    this.invoices.update(invoice._id, { $set: { amountPaid, balance: Math.max(0, balance), status } });
    this._audit("payment.record", "payment", payment._id, {
      receiptNumber,
      amount,
      method,
      invoiceId: invoice._id,
    });
    return { ...payment, invoiceNumber: invoice.invoiceNumber };
  }

  listPayments(query = {}, options = {}) {
    return this.payments.find(query, { sort: options.sort || { createdAt: -1 }, limit: options.limit || 500 });
  }

  getPayment(id) {
    const payment = this.payments.findById(id);
    if (!payment) return null;
    return { ...payment, client: this.clients.findById(payment.clientId) };
  }

  /** End-of-day POS takings by method (a "Z report"). */
  dailyTakings(date = todayISO()) {
    const payments = this.payments.find({ date });
    const byMethod = {};
    let total = 0;
    for (const p of payments) {
      byMethod[p.method] = round2((byMethod[p.method] || 0) + p.amount);
      total = round2(total + p.amount);
    }
    return { date, count: payments.length, total, byMethod, payments };
  }

  /* ========================= M-Pesa / Daraja ========================== */

  findInvoiceByNumber(invoiceNumber) {
    if (!invoiceNumber) return null;
    return this.invoices.findOne({ invoiceNumber: String(invoiceNumber) });
  }

  /**
   * Persist a mobile-money transaction and auto-reconcile it to an invoice
   * when the account reference matches the invoice number. Idempotent on the
   * M-Pesa receipt number.
   */
  recordMpesaTransaction(input = {}) {
    const amount = round2(input.amount);
    this._require(amount > 0, "M-Pesa amount must be greater than zero.");
    if (input.receipt) {
      const dupe = this.mpesa.findOne({ receipt: input.receipt });
      if (dupe) return { ...dupe, duplicate: true };
    }

    const invoice = this.findInvoiceByNumber(input.accountReference);
    let payment = null;
    let status = "unmatched";
    if (invoice && invoice.status !== "void") {
      try {
        payment = this.recordPayment({
          invoiceId: invoice._id,
          amount,
          method: "mpesa",
          reference: input.receipt || "",
          date: input.date || todayISO(),
          notes: "Auto-reconciled from Daraja",
        });
        status = "reconciled";
      } catch (err) {
        status = "reconcile-failed";
      }
    }

    const tx = this.mpesa.insert({
      receipt: input.receipt || null,
      checkoutRequestId: input.checkoutRequestId || null,
      merchantRequestId: input.merchantRequestId || null,
      amount,
      phone: input.phone || null,
      name: input.name || null,
      accountReference: input.accountReference || null,
      transactionDate: input.transactionDate || input.date || null,
      channel: input.channel || "stk", // stk | c2b | b2c | manual
      resultCode: input.resultCode != null ? input.resultCode : null,
      resultDesc: input.resultDesc || null,
      status,
      invoiceId: invoice ? invoice._id : null,
      paymentId: payment ? payment._id : null,
      raw: input.raw || null,
    });
    this._audit("mpesa.record", "mpesaTransaction", tx._id, {
      receipt: input.receipt,
      amount,
      status,
    });
    return { ...tx, invoiceNumber: invoice ? invoice.invoiceNumber : null };
  }

  listMpesaTransactions(query = {}, options = {}) {
    return this.mpesa.find(query, { sort: options.sort || { createdAt: -1 }, limit: options.limit || 500 });
  }

  /** Manually reconcile an unmatched M-Pesa transaction to an invoice. */
  linkMpesaToInvoice(txId, invoiceId) {
    const tx = this.mpesa.findById(txId);
    this._require(tx, "Transaction not found.", 404);
    const invoice = this.invoices.findById(invoiceId);
    this._require(invoice, "Invoice not found.", 404);
    const payment = this.recordPayment({
      invoiceId,
      amount: tx.amount,
      method: "mpesa",
      reference: tx.receipt || "",
      notes: "Manually reconciled from Daraja",
    });
    this.mpesa.update(txId, {
      $set: { status: "reconciled", invoiceId, paymentId: payment._id },
    });
    this._audit("mpesa.link", "mpesaTransaction", txId, { invoiceId });
    return { ...this.mpesa.findById(txId), paymentId: payment._id };
  }

  /* ============================ Trust account ========================== */

  _trustBalance(clientId, matterId) {
    const query = { clientId };
    if (matterId) query.matterId = matterId;
    return round2(
      this.trust
        .find(query)
        .reduce((sum, t) => sum + (t.type === "deposit" ? t.amount : -t.amount), 0)
    );
  }

  trustBalance(clientId, matterId) {
    return this._trustBalance(clientId, matterId);
  }

  trustDeposit(input = {}) {
    const client = this.clients.findById(input.clientId);
    this._require(client, "Client not found.", 404);
    const amount = round2(input.amount);
    this._require(amount > 0, "Deposit must be greater than zero.");
    const entry = this.trust.insert({
      clientId: input.clientId,
      matterId: input.matterId || null,
      type: "deposit",
      amount,
      date: input.date || todayISO(),
      description: String(input.description || "Funds received into client account"),
      reference: String(input.reference || ""),
      balanceAfter: round2(this._trustBalance(input.clientId) + amount),
      recordedBy: input.recordedBy || this._receivedBy,
    });
    this._audit("trust.deposit", "trustTransaction", entry._id, { amount, clientId: input.clientId });
    return entry;
  }

  /**
   * Withdraw from a client's trust balance. Withdrawals must benefit the
   * client only; overdrafts are prohibited by the Advocates (Accounts) Rules.
   */
  trustWithdraw(input = {}) {
    const client = this.clients.findById(input.clientId);
    this._require(client, "Client not found.", 404);
    const amount = round2(input.amount);
    this._require(amount > 0, "Withdrawal must be greater than zero.");
    this._require(input.purpose || input.description, "A purpose is required for a trust withdrawal.");
    const available = this._trustBalance(input.clientId, input.matterId || null);
    this._require(amount <= available + 0.001, `Insufficient trust funds — available ${available}.`, 409);
    const entry = this.trust.insert({
      clientId: input.clientId,
      matterId: input.matterId || null,
      type: "withdrawal",
      amount,
      date: input.date || todayISO(),
      description: String(input.description || input.purpose),
      purpose: String(input.purpose || input.description),
      reference: String(input.reference || ""),
      balanceAfter: round2(available - amount),
      recordedBy: input.recordedBy || this._receivedBy,
    });
    this._audit("trust.withdraw", "trustTransaction", entry._id, { amount, clientId: input.clientId });
    return entry;
  }

  /** Apply client money to an invoice: an authorised trust-to-office transfer. */
  trustTransferToOffice(input = {}) {
    const invoice = this.invoices.findById(input.invoiceId);
    this._require(invoice, "Invoice not found.", 404);
    this._require(invoice.status === "issued" || invoice.status === "part-paid", "Invoice is not payable.", 409);
    const amount = round2(input.amount != null ? input.amount : invoice.balance);
    this.trustWithdraw({
      clientId: invoice.clientId,
      matterId: invoice.matterId,
      amount,
      purpose: `Settlement of invoice ${invoice.invoiceNumber || invoice._id}`,
      reference: invoice.invoiceNumber || "",
      description: "Trust to office — invoice settlement",
    });
    const payment = this.recordPayment({
      invoiceId: invoice._id,
      amount,
      method: "trust-transfer",
      reference: input.reference || invoice.invoiceNumber || "",
    });
    this.office.insert({
      clientId: invoice.clientId,
      matterId: invoice.matterId,
      type: "income",
      amount,
      date: input.date || todayISO(),
      description: `Professional fees — ${invoice.invoiceNumber || invoice._id}`,
      reference: payment.receiptNumber,
    });
    return payment;
  }

  trustLedger(clientId, options = {}) {
    const entries = this.trust.find(
      { clientId },
      { sort: options.sort || { createdAt: 1 } }
    );
    let running = 0;
    const ledger = entries.map((e) => {
      running = round2(running + (e.type === "deposit" ? e.amount : -e.amount));
      return { ...e, runningBalance: running };
    });
    return { clientId, balance: running, entries: ledger };
  }

  /** Reconcile the client account: the sum of all client balances. */
  trustReconciliation() {
    const byClient = {};
    for (const t of this.trust.find()) {
      byClient[t.clientId] = round2(
        (byClient[t.clientId] || 0) + (t.type === "deposit" ? t.amount : -t.amount)
      );
    }
    const total = round2(Object.values(byClient).reduce((s, v) => s + v, 0));
    const negative = Object.entries(byClient).filter(([, v]) => v < -0.001);
    return {
      total,
      clients: Object.keys(byClient).length,
      byClient,
      overdrawn: negative.length,
      compliant: negative.length === 0,
    };
  }

  /* ============================= Expenses ============================== */

  recordExpense(input = {}) {
    const amount = round2(input.amount);
    this._require(amount > 0, "Expense amount must be greater than zero.");
    const vatAmount = round2(input.vatAmount || 0);
    const expense = this.expenses.insert({
      category: String(input.category || "office"),
      description: String(input.description || ""),
      amount,
      vatAmount,
      netAmount: round2(amount - vatAmount),
      date: input.date || todayISO(),
      paidTo: String(input.paidTo || ""),
      method: String(input.method || "bank"),
      pin: String(input.pin || "").toUpperCase(),
      receiptRef: String(input.receiptRef || ""),
    });
    this.office.insert({
      category: expense.category,
      type: "expense",
      amount,
      vatAmount,
      date: expense.date,
      description: expense.description,
      reference: expense.receiptRef,
    });
    this._audit("expense.record", "expense", expense._id, { amount, category: expense.category });
    return expense;
  }

  listExpenses(query = {}, options = {}) {
    return this.expenses.find(query, { sort: options.sort || { date: -1 }, limit: options.limit || 500 });
  }

  /* ============================== eTIMS ================================ */

  buildEtimsPayload(invoice) {
    const client = this.clients.findById(invoice.clientId) || {};
    return {
      // KRA eTIMS tax-invoice particulars (VAT Act 2013, s.25 + ETR rules)
      traPin: this.config.seller.pin,
      traName: this.config.seller.name,
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.date,
      customerPin: client.pin || null,
      customerName: client.name || null,
      paymentType: "cash",
      currency: invoice.currency,
      itemList: (invoice.lines || []).map((l, i) => ({
        itemSeq: i + 1,
        itemName: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        lineAmount: l.base,
        taxType: l.vatCode === "standard" ? "A" : l.vatCode === "zero" ? "B" : "E",
        taxRate: l.vatCode === "standard" ? this.config.vatRate * 100 : 0,
        taxAmount: l.vatAmount,
      })),
      totalTaxableAmount: invoice.subtotal,
      totalTaxAmount: invoice.vatTotal,
      totalAmount: invoice.total,
    };
  }

  /** Submit an issued invoice to eTIMS. Uses a local stub unless a hook is set. */
  transmitInvoice(id) {
    const invoice = this.invoices.findById(id);
    this._require(invoice, "Invoice not found.", 404);
    this._require(invoice.status !== "draft", "Issue the invoice before transmitting.", 409);
    if (!this.config.eTims || !this.config.eTims.enabled) {
      this.invoices.update(id, { $set: { "etims.status": "disabled" } });
      return { status: "disabled" };
    }
    const payload = this.buildEtimsPayload(invoice);
    try {
      let result;
      if (typeof this._transmitHook === "function") {
        result = this._transmitHook(payload) || {};
        if (result.then) throw new ERPError("Async eTIMS hooks must be synchronous.", 500);
      } else {
        // Deterministic local control code — replace with the KRA/VSCU response.
        const digest = crypto
          .createHash("sha256")
          .update(JSON.stringify(payload) + this.config.eTims.deviceId)
          .digest("hex")
          .slice(0, 16)
          .toUpperCase();
        result = {
          controlCode: `${this.config.seller.pin}/${invoice.invoiceNumber}/${digest}`,
          signature: digest,
        };
      }
      this.invoices.update(id, {
        $set: {
          "etims.status": "submitted",
          "etims.controlCode": result.controlCode,
          "etims.qrData": result.signature || null,
          "etims.submittedAt": new Date().toISOString(),
          "etims.payload": payload,
        },
      });
      this._audit("etims.transmit", "invoice", id, { controlCode: result.controlCode });
      return { status: "submitted", ...result };
    } catch (err) {
      this.invoices.update(id, { $set: { "etims.status": "failed", "etims.error": err.message } });
      this._audit("etims.transmit.failed", "invoice", id, { error: err.message });
      throw new ERPError("eTIMS transmission failed: " + err.message, 502);
    }
  }

  /* ============================= Reports =============================== */

  receivables() {
    const open = this.invoices.find({ status: { $in: ["issued", "part-paid"] } });
    const total = round2(open.reduce((s, i) => s + i.balance, 0));
    return { total, count: open.length, invoices: open };
  }

  agedDebtors(asOf = todayISO()) {
    const buckets = { current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0 };
    const ref = new Date(asOf + "T00:00:00Z");
    for (const inv of this.invoices.find({ status: { $in: ["issued", "part-paid"] } })) {
      const due = new Date(inv.dueDate + "T00:00:00Z");
      const days = Math.floor((ref - due) / 86400000);
      const bal = round2(inv.balance);
      if (days <= 0) buckets.current = round2(buckets.current + bal);
      else if (days <= 30) buckets.d30 = round2(buckets.d30 + bal);
      else if (days <= 60) buckets.d60 = round2(buckets.d60 + bal);
      else if (days <= 90) buckets.d90 = round2(buckets.d90 + bal);
      else buckets.d90plus = round2(buckets.d90plus + bal);
    }
    buckets.total = round2(
      buckets.current + buckets.d30 + buckets.d60 + buckets.d90 + buckets.d90plus
    );
    return buckets;
  }

  /** VAT summary for the return period (output VAT vs input VAT). */
  vatReturn(from, to) {
    const inRange = (d) => (!from || d >= from) && (!to || d <= to);
    const sales = this.invoices.find({ status: { $in: ["issued", "part-paid", "paid"] } })
      .filter((i) => inRange(i.date));
    const outputVat = round2(sales.reduce((s, i) => s + i.vatTotal, 0));
    const standardSales = round2(sales.reduce((s, i) => s + i.subtotal, 0));
    const purchases = this.expenses.find().filter((e) => inRange(e.date));
    const inputVat = round2(purchases.reduce((s, e) => s + (e.vatAmount || 0), 0));
    return {
      from: from || null,
      to: to || null,
      outputVat,
      inputVat,
      netVatPayable: round2(outputVat - inputVat),
      standardRatedSales: standardSales,
      invoices: sales.length,
    };
  }

  whtSchedule(from, to) {
    const inRange = (d) => (!from || d >= from) && (!to || d <= to);
    const rows = this.invoices
      .find({ status: { $in: ["issued", "part-paid", "paid"] } })
      .filter((i) => inRange(i.date) && i.whtAmount > 0)
      .map((i) => {
        const client = this.clients.findById(i.clientId) || {};
        return {
          invoiceNumber: i.invoiceNumber,
          client: client.name,
          pin: client.pin || null,
          gross: i.subtotal,
          rate: i.whtRate,
          wht: i.whtAmount,
          date: i.date,
        };
      });
    return {
      from: from || null,
      to: to || null,
      total: round2(rows.reduce((s, r) => s + r.wht, 0)),
      rows,
    };
  }

  revenueByPracticeArea() {
    const byArea = {};
    for (const inv of this.invoices.find({ status: { $in: ["issued", "part-paid", "paid"] } })) {
      const matter = inv.matterId ? this.matters.findById(inv.matterId) : null;
      const area = matter ? matter.practiceArea : "Unallocated";
      byArea[area] = round2((byArea[area] || 0) + inv.subtotal);
    }
    return byArea;
  }

  /** Client statement: invoices, payments and trust activity. */
  clientStatement(clientId) {
    const client = this.clients.findById(clientId);
    if (!client) return null;
    const invoices = this.invoices.find({ clientId }, { sort: { date: 1 } });
    const payments = this.payments.find({ clientId }, { sort: { date: 1 } });
    const trust = this.trustLedger(clientId);
    const invoiced = round2(invoices.reduce((s, i) => s + i.total, 0));
    const paid = round2(payments.reduce((s, p) => s + p.amount, 0));
    return {
      client,
      invoices,
      payments,
      trust: trust.entries,
      trustBalance: trust.balance,
      summary: { invoiced, paid, outstanding: round2(invoiced - paid) },
    };
  }

  trialBalance() {
    const receivables = this.receivables().total;
    const trustTotal = this.trustReconciliation().total;
    const income = round2(
      this.invoices
        .find({ status: { $in: ["issued", "part-paid", "paid"] } })
        .reduce((s, i) => s + i.subtotal, 0)
    );
    const outputVat = round2(
      this.invoices
        .find({ status: { $in: ["issued", "part-paid", "paid"] } })
        .reduce((s, i) => s + i.vatTotal, 0)
    );
    const expenses = round2(this.expenses.find().reduce((s, e) => s + e.netAmount, 0));
    const inputVat = round2(this.expenses.find().reduce((s, e) => s + (e.vatAmount || 0), 0));
    return {
      accounts: [
        { account: "Trade receivables", debit: receivables },
        { account: "Client (trust) account", debit: trustTotal },
        { account: "Professional fee income", credit: income },
        { account: "Output VAT", credit: outputVat },
        { account: "Operating expenses", debit: expenses },
        { account: "Input VAT", debit: inputVat },
      ],
      totals: {
        debit: round2(receivables + trustTotal + expenses + inputVat),
        credit: round2(income + outputVat),
      },
      note:
        "Trust money is held on behalf of clients and is not firm income; " +
        "it is presented for reconciliation only.",
    };
  }

  dashboard() {
    const feeIncome = round2(
      this.invoices
        .find({ status: { $in: ["issued", "part-paid", "paid"] } })
        .reduce((s, i) => s + i.subtotal, 0)
    );
    const collected = round2(this.payments.find().reduce((s, p) => s + p.amount, 0));
    return {
      clients: this.clients.count(),
      activeMatters: this.matters.count({ status: "open" }),
      openInvoices: this.receivables().count,
      receivables: this.receivables().total,
      feeIncome,
      collected,
      trustBalance: this.trustReconciliation().total,
      unbilledHours: round2(
        this.timeEntries.find({ billable: true, invoiced: false }).reduce((s, t) => s + t.hours, 0)
      ),
      todayTakings: this.dailyTakings().total,
    };
  }

  /* ======================= Kenyan compliance view ====================== */

  compliance() {
    const flagged = this.clients.find({ "riskAssessment.rating": { $in: ["high"] } });
    const pendingKyc = this.clients.count({ kycStatus: { $ne: "verified" } });
    const trust = this.trustReconciliation();
    const unnumbered = this.invoices.count({
      status: { $in: ["issued", "part-paid", "paid"] },
      invoiceNumber: null,
    });
    const unsubmittedEtims = this.invoices.count({
      status: { $in: ["issued", "part-paid", "paid"] },
      "etims.status": { $ne: "submitted" },
    });
    return {
      statutes: [
        { act: "VAT Act, 2013", requirement: "16% standard VAT + tax invoices", met: !!this.config.vatRegistered },
        { act: "Finance Act / eTIMS", requirement: "Electronic tax invoice submission", met: unsubmittedEtims === 0 },
        { act: "Income Tax Act (Cap. 470)", requirement: "Withholding tax on professional fees", met: this.config.whtResidentRate > 0 },
        { act: "Advocates (Accounts) Rules", requirement: "Client account not overdrawn", met: trust.compliant },
        { act: "POCAMLA, 2009", requirement: "Client due diligence / KYC", met: pendingKyc === 0 },
        { act: "Data Protection Act, 2019", requirement: `Retention ${this.config.retentionYears} years`, met: this.config.retentionYears >= 5 },
      ],
      warnings: {
        highRiskClients: flagged.map((c) => ({ id: c._id, name: c.name })),
        pendingKyc,
        trustOverdrawn: trust.overdrawn,
        invoicesMissingNumbers: unnumbered,
        invoicesNotSubmittedToEtims: unsubmittedEtims,
      },
      seller: this.config.seller,
      trustBank: this.config.trustBank,
    };
  }

  /* ============================== Fee scales =========================== */

  /** Advocates (Remuneration) Order scale fee. Brackets are configurable. */
  computeScaleFee(value, scaleName = "conveyancing") {
    const brackets = (this.config.feeScales && this.config.feeScales[scaleName]) || [];
    this._require(brackets.length, `No fee scale configured for "${scaleName}".`, 404);
    const amount = Number(value);
    this._require(amount >= 0, "Value must be non-negative.");
    const bracket = brackets.find((b) => b.upTo == null || amount <= b.upTo) || brackets[brackets.length - 1];
    return {
      scale: scaleName,
      value: round2(amount),
      rate: bracket.rate,
      fee: round2(amount * bracket.rate),
      bracket: { upTo: bracket.upTo, rate: bracket.rate },
      note: "Illustrative ARO scale — confirm against the current Advocates (Remuneration) Order.",
    };
  }
}

module.exports = { ERP, ERPError, DEFAULT_CONFIG, round2 };
