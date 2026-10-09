/* ==========================================================================
   Equitas Law — shared API handler (zero-dependency)
   --------------------------------------------------------------------------
   A pure function over an abstract request object. The same handler powers:
     • server.js            (self-hosted, pure Node http server)
     • netlify/functions/api.js  (Netlify serverless runtime)
   Both adapt their native request shapes to { method, path, query,
   headers, body } and translate the { status, headers, body } response.
   ========================================================================== */
"use strict";

const { Daraja: DarajaLib } = require("./daraja");

const COLLECTIONS_PUBLIC = ["practice-areas", "team", "insights", "testimonials"];

function json(status, body, extraHeaders) {
  return {
    status,
    headers: Object.assign(
      { "content-type": "application/json; charset=utf-8" },
      extraHeaders || {}
    ),
    body: JSON.stringify(body),
  };
}

function isAdmin(req, adminKey) {
  const key = req.headers["x-admin-key"] || req.query.adminKey || "";
  return adminKey && key === adminKey;
}

/* --- naive fixed-window rate limiter, in-memory, per IP --- */
function createRateLimiter(limit, windowMs) {
  const hits = new Map(); // ip -> { count, resetAt }
  return function allows(ip) {
    const now = Date.now();
    const entry = hits.get(ip);
    if (!entry || now > entry.resetAt) {
      hits.set(ip, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (entry.count >= limit) return false;
    entry.count++;
    return true;
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validateConsultation(data) {
  const errors = {};
  const name = String(data.name || "").trim();
  const email = String(data.email || "").trim();
  const phone = String(data.phone || "").trim();
  const service = String(data.service || "").trim();
  const message = String(data.message || "").trim();

  if (name.length < 2 || name.length > 120) errors.name = "Please provide your full name.";
  if (!EMAIL_RE.test(email)) errors.email = "Please provide a valid email address.";
  if (phone && phone.replace(/[^\d+]/g, "").length < 7)
    errors.phone = "Please provide a valid phone number.";
  if (service.length > 120) errors.service = "Unknown service.";
  if (message.length < 10 || message.length > 5000)
    errors.message = "Please tell us briefly about your matter (10–5000 characters).";

  return { errors, clean: { name, email, phone, service, message } };
}

function readBody(req) {
  try {
    return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  } catch {
    return null;
  }
}

/**
 * @param {EquitasDB} db
 * @param {{ adminKey?: string,
 *           mail?: { store: MailStore,
 *                    status: () => object,
 *                    sendOutbound?: (msg) => Promise<object> },
 *           erp?: ERP,
 *           notifyMailbox?: string }} options
 */
function createApiHandler(db, options) {
  const adminKey = options.adminKey || "equitas-admin";
  const mail = options.mail || null;
  const erp = options.erp || null;
  const daraja = options.daraja || null;
  const notifyMailbox = options.notifyMailbox || "d.i.majanja@equitaslaw.org";
  const allowConsultation = createRateLimiter(6, 10 * 60 * 1000); // 6 per 10 min
  const admin = (req) => isAdmin(req, adminKey);

  const team = db.collection("team");
  team.createIndex("slug");
  db.collection("insights").createIndex("slug");
  db.collection("practice-areas");

  return async function handleApi(req) {
    const path = req.path.replace(/\/+$/, "") || "/";
    const seg = path.split("/").filter(Boolean); // e.g. ["insights","my-slug"]
    const route = seg[0] || "";

    try {
      /* ----------------------------- health & stats ---------------------- */
      if (route === "health" && req.method === "GET" && seg.length === 1) {
        return json(200, {
          ok: true,
          engine: "EquitasDB/1 (zero-dependency NoSQL)",
          time: new Date().toISOString(),
        });
      }

      if (route === "stats" && req.method === "GET" && seg.length === 1) {
        return json(200, { ok: true, collections: db.stats() });
      }

      /* ---------------------------- practice areas ------------------------ */
      if (route === "practice-areas" && req.method === "GET") {
        const docs = db
          .collection("practice-areas")
          .find({}, { sort: { order: 1 } });
        return json(200, { ok: true, data: docs });
      }

      /* -------------------------------- team ------------------------------ */
      if (route === "team" && req.method === "GET") {
        const docs = team.find({}, { sort: { order: 1 } });
        return json(200, { ok: true, data: docs });
      }

      /* ------------------------------ insights ---------------------------- */
      if (route === "insights" && req.method === "GET" && seg.length === 1) {
        const category = req.query.category;
        const query = category ? { category } : {};
        const docs = db
          .collection("insights")
          .find(query, { sort: { date: -1 }, projection: { body: 0 } });
        return json(200, { ok: true, data: docs });
      }

      if (route === "insights" && req.method === "GET" && seg.length === 2) {
        const doc = db.collection("insights").findOne({ slug: seg[1] });
        if (!doc) return json(404, { ok: false, error: "Article not found." });
        return json(200, { ok: true, data: doc });
      }

      /* ---------------------------- testimonials -------------------------- */
      if (route === "testimonials" && req.method === "GET") {
        const docs = db
          .collection("testimonials")
          .find({}, { sort: { order: 1 } });
        return json(200, { ok: true, data: docs });
      }

      /* --------------------------- consultations -------------------------- */
      if (route === "consultations" && req.method === "POST") {
        const ip = req.headers["x-forwarded-for"] || req.ip || "unknown";
        if (!allowConsultation(ip)) {
          return json(429, {
            ok: false,
            error: "Too many requests. Please try again later or call us directly.",
          });
        }

        let payload;
        try {
          payload = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
        } catch {
          return json(400, { ok: false, error: "Invalid request body." });
        }

        // Honeypot: bots fill hidden "company" field — pretend success.
        if (String(payload.company || "").trim() !== "") {
          return json(200, { ok: true });
        }

        const { errors, clean } = validateConsultation(payload);
        if (Object.keys(errors).length) {
          return json(422, { ok: false, error: "Please correct the highlighted fields.", fields: errors });
        }

        const record = db.collection("consultations").insert({
          ...clean,
          status: "new",
          source: "website",
          userAgent: String(req.headers["user-agent"] || "").slice(0, 300),
        });

        // Push the enquiry into the CRM as a client record (idempotent).
        if (erp) {
          try {
            erp.createClientFromConsultation(clean);
          } catch (_) {
            /* CRM sync must never break the request */
          }
        }

        // Drop a notification into the chambers mailbox (zero-dep mail store).
        if (mail) {
          try {
            mail.store.saveMessage({
              mailbox: notifyMailbox,
              direction: "in",
              from: `${clean.name} <${clean.email}>`,
              to: [notifyMailbox],
              subject: `New consultation request — ${clean.service || "General"}`,
              text:
                `A new consultation request was logged in the chambers system.\n\n` +
                `Reference : ${record._id}\nName      : ${clean.name}\n` +
                `Email     : ${clean.email}\nPhone     : ${clean.phone || "—"}\n` +
                `Service   : ${clean.service || "—"}\n\nMessage:\n${clean.message}\n\n` +
                `— Equitas Law website`,
              read: false,
            });
          } catch (_) {
            /* notification must never break the request */
          }
        }

        return json(201, {
          ok: true,
          message: "Consultation request received.",
          reference: record._id,
        });
      }

      if (route === "consultations" && req.method === "GET") {
        if (!isAdmin(req, adminKey))
          return json(401, { ok: false, error: "Unauthorised." });
        const statusFilter = req.query.status;
        const query = statusFilter ? { status: statusFilter } : {};
        const docs = db
          .collection("consultations")
          .find(query, { sort: { createdAt: -1 }, limit: 200 });
        return json(200, { ok: true, data: docs });
      }

      if (route === "consultations" && req.method === "PATCH" && seg.length === 2) {
        if (!isAdmin(req, adminKey))
          return json(401, { ok: false, error: "Unauthorised." });
        let payload = {};
        try {
          payload = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
        } catch {
          return json(400, { ok: false, error: "Invalid request body." });
        }
        const allowed = ["new", "contacted", "scheduled", "closed"];
        if (!allowed.includes(payload.status))
          return json(422, { ok: false, error: "Invalid status." });
        const result = db
          .collection("consultations")
          .update(seg[1], { $set: { status: payload.status } });
        if (!result.matched) return json(404, { ok: false, error: "Not found." });
        return json(200, { ok: true, ...result });
      }

      if (route === "consultations" && req.method === "DELETE" && seg.length === 2) {
        if (!isAdmin(req, adminKey))
          return json(401, { ok: false, error: "Unauthorised." });
        const result = db.collection("consultations").delete(seg[1]);
        if (!result.deleted) return json(404, { ok: false, error: "Not found." });
        return json(200, { ok: true, ...result });
      }

      /* ------------------- NoSQL query console (admin) -------------------- */
      if (route === "query" && req.method === "POST") {
        if (!isAdmin(req, adminKey))
          return json(401, { ok: false, error: "Unauthorised." });
        let payload = {};
        try {
          payload = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
        } catch {
          return json(400, { ok: false, error: "Invalid request body." });
        }
        const name = String(payload.collection || "");
        if (!/^[a-zA-Z0-9_-]+$/.test(name))
          return json(422, { ok: false, error: "Invalid collection name." });
        if (!isAdmin(req, adminKey) && !COLLECTIONS_PUBLIC.includes(name))
          return json(403, { ok: false, error: "Forbidden collection." });
        const col = db.collection(name);
        const data = col.find(payload.query || {}, {
          sort: payload.sort,
          skip: Math.min(Number(payload.skip) || 0, 10000),
          limit: Math.min(Number(payload.limit) || 50, 200),
        });
        return json(200, { ok: true, count: data.length, data });
      }

      /* ------------------------------ mail server ------------------------- */
      if (route === "mail") {
        if (!mail) return json(503, { ok: false, error: "Mail subsystem not enabled." });
        const sub = seg[1] || "";

        if (sub === "status" && req.method === "GET") {
          return json(200, { ok: true, smtp: mail.status(), mailboxes: mail.store.counts() });
        }

        if (sub === "mailboxes" && req.method === "GET") {
          if (!isAdmin(req, adminKey)) return json(401, { ok: false, error: "Unauthorised." });
          return json(200, { ok: true, data: mail.store.listMailboxes() });
        }

        if (sub === "inbox" && req.method === "GET" && seg.length === 3) {
          if (!isAdmin(req, adminKey)) return json(401, { ok: false, error: "Unauthorised." });
          const data = mail.store.inbox(seg[2], {
            limit: Math.min(Number(req.query.limit) || 100, 500),
            unreadOnly: req.query.unread === "1",
          });
          return json(200, { ok: true, data });
        }

        if (sub === "message" && seg.length === 3) {
          if (!isAdmin(req, adminKey)) return json(401, { ok: false, error: "Unauthorised." });
          const id = seg[2];
          if (req.method === "GET") {
            const msg = mail.store.getMessage(id);
            if (!msg) return json(404, { ok: false, error: "Message not found." });
            mail.store.markRead(id, true);
            return json(200, { ok: true, data: msg });
          }
          if (req.method === "PATCH") {
            let payload = {};
            try {
              payload = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
            } catch {
              return json(400, { ok: false, error: "Invalid request body." });
            }
            const result = mail.store.markRead(id, payload.read !== false);
            if (!result.matched) return json(404, { ok: false, error: "Not found." });
            return json(200, { ok: true, ...result });
          }
          if (req.method === "DELETE") {
            const result = mail.store.deleteMessage(id);
            if (!result.deleted) return json(404, { ok: false, error: "Not found." });
            return json(200, { ok: true, ...result });
          }
        }

        if (sub === "send" && req.method === "POST") {
          if (!isAdmin(req, adminKey)) return json(401, { ok: false, error: "Unauthorised." });
          let payload = {};
          try {
            payload = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
          } catch {
            return json(400, { ok: false, error: "Invalid request body." });
          }
          const from = String(payload.from || notifyMailbox).trim();
          const to = String(payload.to || "").trim();
          const subject = String(payload.subject || "").slice(0, 200);
          const text = String(payload.text || "").slice(0, 50000);
          if (!to || !text) return json(422, { ok: false, error: "Recipient and message body are required." });

          if (mail.store.isLocalAddress(to)) {
            // Local delivery: sender outbox copy + recipient inbox copy.
            mail.store.saveMessage({ mailbox: from, direction: "out", from, to: [to], subject, text });
            mail.store.saveMessage({ mailbox: to, direction: "in", from, to: [to], subject, text });
            return json(201, { ok: true, delivered: "local", to });
          }
          if (!mail.sendOutbound) {
            return json(502, {
              ok: false,
              error: "Outbound relay is unavailable in this runtime (serverless). Self-host server.js for full SMTP.",
            });
          }
          try {
            const result = await mail.sendOutbound({ from, to, subject, text });
            mail.store.saveMessage({ mailbox: from, direction: "out", from, to: [to], subject, text });
            return json(201, { ok: true, delivered: "remote", via: result.server, to });
          } catch (err) {
            return json(502, { ok: false, error: "Outbound delivery failed: " + err.message });
          }
        }
      }

      /* ================= Business suite: CRM · ERP · POS ================== */
      if (route === "crm" || route === "erp" || route === "pos") {
        if (!erp) return json(503, { ok: false, error: "Business suite not enabled." });
        if (!admin(req)) return json(401, { ok: false, error: "Unauthorised." });
        const sub = seg[1] || "";
        const id = seg[2] || "";
        const action = seg[3] || "";

        /* ------------------------------- CRM ------------------------------ */
        if (route === "crm") {
          if (sub === "clients") {
            if (req.method === "GET" && seg.length === 2) {
              const q = {};
              if (req.query.status) q.status = req.query.status;
              if (req.query.risk) q["riskAssessment.rating"] = req.query.risk;
              if (req.query.q) q.name = { $regex: req.query.q };
              return json(200, { ok: true, data: erp.listClients(q) });
            }
            if (req.method === "POST" && seg.length === 2) {
              const payload = readBody(req);
              if (!payload) return json(400, { ok: false, error: "Invalid request body." });
              return json(201, { ok: true, data: erp.createClient(payload) });
            }
            if (req.method === "GET" && seg.length === 3) {
              const client = erp.getClient(id);
              if (!client) return json(404, { ok: false, error: "Client not found." });
              return json(200, { ok: true, data: client });
            }
            if (req.method === "PATCH" && seg.length === 3) {
              const payload = readBody(req);
              if (!payload) return json(400, { ok: false, error: "Invalid request body." });
              return json(200, { ok: true, data: erp.updateClient(id, payload) });
            }
            if (req.method === "DELETE" && seg.length === 3) {
              const result = erp.clients.delete(id);
              if (!result.deleted) return json(404, { ok: false, error: "Not found." });
              return json(200, { ok: true, ...result });
            }
          }
          if (sub === "clients" && action === "kyc" && req.method === "POST" && seg.length === 4) {
            const payload = readBody(req) || {};
            return json(200, { ok: true, data: erp.verifyKyc(id, payload) });
          }
          if (sub === "clients" && action === "statement" && req.method === "GET" && seg.length === 4) {
            const statement = erp.clientStatement(id);
            if (!statement) return json(404, { ok: false, error: "Client not found." });
            return json(200, { ok: true, data: statement });
          }
          if (sub === "dashboard" && req.method === "GET") {
            return json(200, { ok: true, data: erp.dashboard() });
          }
          return json(404, { ok: false, error: "Unknown CRM endpoint." });
        }

        /* ------------------------------- POS ------------------------------ */
        if (route === "pos") {
          if (sub === "payments" && req.method === "GET" && seg.length === 2) {
            const q = {};
            if (req.query.clientId) q.clientId = req.query.clientId;
            if (req.query.invoiceId) q.invoiceId = req.query.invoiceId;
            if (req.query.date) q.date = req.query.date;
            return json(200, { ok: true, data: erp.listPayments(q) });
          }
          if (sub === "payments" && req.method === "POST" && seg.length === 2) {
            const payload = readBody(req);
            if (!payload) return json(400, { ok: false, error: "Invalid request body." });
            return json(201, { ok: true, data: erp.recordPayment(payload) });
          }
          if (sub === "payments" && req.method === "GET" && seg.length === 3) {
            const payment = erp.getPayment(id);
            if (!payment) return json(404, { ok: false, error: "Payment not found." });
            return json(200, { ok: true, data: payment });
          }
          if (sub === "takings" && req.method === "GET") {
            return json(200, { ok: true, data: erp.dailyTakings(req.query.date) });
          }
          return json(404, { ok: false, error: "Unknown POS endpoint." });
        }

        /* ------------------------------- ERP ------------------------------ */
        if (sub === "matters") {
          if (req.method === "GET" && seg.length === 2) {
            const q = {};
            if (req.query.clientId) q.clientId = req.query.clientId;
            if (req.query.status) q.status = req.query.status;
            return json(200, { ok: true, data: erp.listMatters(q) });
          }
          if (req.method === "POST" && seg.length === 2) {
            const payload = readBody(req);
            if (!payload) return json(400, { ok: false, error: "Invalid request body." });
            return json(201, { ok: true, data: erp.openMatter(payload) });
          }
          if (req.method === "GET" && seg.length === 3) {
            const matter = erp.getMatter(id);
            if (!matter) return json(404, { ok: false, error: "Matter not found." });
            return json(200, { ok: true, data: matter });
          }
          if (req.method === "PATCH" && seg.length === 3) {
            const payload = readBody(req) || {};
            return json(200, { ok: true, data: erp.updateMatter(id, payload) });
          }
        }

        if (sub === "time" && req.method === "GET") {
          const q = {};
          if (req.query.matterId) q.matterId = req.query.matterId;
          return json(200, { ok: true, data: erp.listTime(q) });
        }
        if (sub === "time" && req.method === "POST") {
          const payload = readBody(req);
          if (!payload) return json(400, { ok: false, error: "Invalid request body." });
          return json(201, { ok: true, data: erp.logTime(payload) });
        }

        if (sub === "invoices") {
          if (req.method === "GET" && seg.length === 2) {
            const q = {};
            if (req.query.clientId) q.clientId = req.query.clientId;
            if (req.query.status) q.status = req.query.status;
            return json(200, { ok: true, data: erp.listInvoices(q) });
          }
          if (req.method === "POST" && seg.length === 2) {
            const payload = readBody(req);
            if (!payload) return json(400, { ok: false, error: "Invalid request body." });
            const invoice = payload.matterId && payload.fromTime
              ? erp.createInvoiceFromTime(payload.matterId, payload)
              : erp.createInvoice(payload);
            return json(201, { ok: true, data: invoice });
          }
          if (req.method === "GET" && seg.length === 3) {
            const invoice = erp.getInvoice(id);
            if (!invoice) return json(404, { ok: false, error: "Invoice not found." });
            return json(200, { ok: true, data: invoice });
          }
          if (req.method === "POST" && action === "issue" && seg.length === 4) {
            return json(200, { ok: true, data: erp.issueInvoice(id) });
          }
          if (req.method === "POST" && action === "etims" && seg.length === 4) {
            return json(200, { ok: true, data: erp.transmitInvoice(id) });
          }
          if (req.method === "POST" && action === "void" && seg.length === 4) {
            const payload = readBody(req) || {};
            return json(200, { ok: true, data: erp.voidInvoice(id, payload) });
          }
        }

        if (sub === "trust") {
          if (req.method === "GET" && id === "reconciliation") {
            return json(200, { ok: true, data: erp.trustReconciliation() });
          }
          if (req.method === "GET" && id === "ledger" && seg.length === 4) {
            return json(200, { ok: true, data: erp.trustLedger(action) });
          }
          if (req.method === "POST" && id === "deposit") {
            return json(201, { ok: true, data: erp.trustDeposit(readBody(req) || {}) });
          }
          if (req.method === "POST" && id === "withdraw") {
            return json(201, { ok: true, data: erp.trustWithdraw(readBody(req) || {}) });
          }
          if (req.method === "POST" && id === "settle") {
            return json(201, { ok: true, data: erp.trustTransferToOffice(readBody(req) || {}) });
          }
        }

        if (sub === "expenses") {
          if (req.method === "GET") return json(200, { ok: true, data: erp.listExpenses() });
          if (req.method === "POST") {
            return json(201, { ok: true, data: erp.recordExpense(readBody(req) || {}) });
          }
        }

        if (sub === "audit" && req.method === "GET") {
          return json(200, {
            ok: true,
            data: erp.audit.find({}, { sort: { createdAt: -1 }, limit: 200 }),
          });
        }

        if (sub === "fee-scale" && req.method === "GET") {
          return json(200, {
            ok: true,
            data: erp.computeScaleFee(req.query.value || 0, req.query.scale || "conveyancing"),
          });
        }

        if (sub === "reports" && req.method === "GET") {
          const reports = {
            dashboard: () => erp.dashboard(),
            "trial-balance": () => erp.trialBalance(),
            "aged-debtors": () => erp.agedDebtors(req.query.asOf),
            vat: () => erp.vatReturn(req.query.from, req.query.to),
            wht: () => erp.whtSchedule(req.query.from, req.query.to),
            revenue: () => erp.revenueByPracticeArea(),
            receivables: () => erp.receivables(),
            compliance: () => erp.compliance(),
          };
          if (!reports[id]) return json(404, { ok: false, error: "Unknown report." });
          return json(200, { ok: true, data: reports[id]() });
        }

        return json(404, { ok: false, error: "Unknown business-suite endpoint." });
      }

      /* ================== M-Pesa (Safaricom Daraja) ====================== */
      if (route === "mpos") {
        const sub = seg[1] || "";
        const id = seg[2] || "";
        const action = seg[3] || "";

        // Public callbacks posted by Safaricom — no admin key required.
        if (sub === "callback") {
          const kind = id;
          const payload = readBody(req) || {};

          if (kind === "c2b" && action === "validation") {
            // Validation: verify the account number exists, then accept.
            const ref = payload.BillRefNumber;
            const known = ref && db.collection("invoices").findOne({ invoiceNumber: ref });
            return json(200, {
              ResultCode: known ? 0 : 0,
              ResultDesc: "Accepted",
            });
          }
          if (kind === "c2b" && action === "confirmation") {
            if (erp) {
              try {
                const c = DarajaLib.parseC2bConfirmation(payload);
                erp.recordMpesaTransaction({
                  receipt: c.receipt,
                  amount: c.amount,
                  phone: c.phone,
                  name: c.name,
                  accountReference: c.accountReference,
                  transactionDate: c.transTime,
                  channel: "c2b",
                  raw: payload,
                });
              } catch (_) {
                /* never fail a callback */
              }
            }
            return json(200, { ResultCode: 0, ResultDesc: "Accepted" });
          }
          if (kind === "stk") {
            if (erp) {
              const parsed = DarajaLib.parseStkCallback(payload);
              try {
                if (parsed.success && parsed.receipt) {
                  const pending = erp.mpesa.findOne({
                    checkoutRequestId: parsed.checkoutRequestId,
                  });
                  erp.recordMpesaTransaction({
                    receipt: parsed.receipt,
                    amount: parsed.amount,
                    phone: parsed.phone,
                    accountReference: pending ? pending.accountReference : null,
                    checkoutRequestId: parsed.checkoutRequestId,
                    merchantRequestId: parsed.merchantRequestId,
                    transactionDate: parsed.date,
                    channel: "stk",
                    resultCode: parsed.resultCode,
                    resultDesc: parsed.resultDesc,
                    raw: payload,
                  });
                  // remove the now-settled pending placeholder
                  erp.mpesa.delete({ checkoutRequestId: parsed.checkoutRequestId, receipt: null });
                } else if (parsed.checkoutRequestId) {
                  erp.mpesa.update(
                    { checkoutRequestId: parsed.checkoutRequestId, receipt: null },
                    { $set: { status: "failed", resultCode: parsed.resultCode, resultDesc: parsed.resultDesc } }
                  );
                }
              } catch (_) {
                /* swallow — always ack */
              }
            }
            return json(200, { ResultCode: 0, ResultDesc: "Accepted" });
          }
          // B2C / status / reversal / balance result callbacks
          return json(200, { ResultCode: 0, ResultDesc: "Accepted" });
        }

        // Every other M-Pesa endpoint is admin-only.
        if (!daraja) return json(503, { ok: false, error: "M-Pesa (Daraja) is not configured." });
        if (!admin(req)) return json(401, { ok: false, error: "Unauthorised." });

        if (sub === "status" && req.method === "GET") {
          return json(200, { ok: true, data: daraja.configured });
        }

        if (sub === "stkpush" && req.method === "POST") {
          const payload = readBody(req);
          if (!payload) return json(400, { ok: false, error: "Invalid request body." });
          let amount = payload.amount;
          let accountReference = payload.accountReference;
          if (payload.invoiceId && erp) {
            const invoice = erp.getInvoice(payload.invoiceId);
            if (!invoice) return json(404, { ok: false, error: "Invoice not found." });
            accountReference = invoice.invoiceNumber;
            amount = amount != null ? amount : invoice.balance;
          }
          if (!payload.phone) return json(422, { ok: false, error: "A phone number is required." });
          const result = await daraja.stkPush({
            phone: payload.phone,
            amount,
            accountReference,
            description: payload.description,
          });
          if (erp && result.checkoutRequestId) {
            try {
              erp.mpesa.insert({
                receipt: null,
                checkoutRequestId: result.checkoutRequestId,
                merchantRequestId: result.merchantRequestId,
                amount: Number(amount) || 0,
                phone: String(payload.phone),
                accountReference: accountReference || null,
                channel: "stk",
                status: "pending",
              });
            } catch (_) {}
          }
          return json(result.ok ? 200 : 502, { ok: result.ok, data: result });
        }

        if (sub === "stk" && id === "query" && req.method === "GET") {
          const result = await daraja.stkQuery({ checkoutRequestId: req.query.checkoutRequestId });
          return json(result.ok ? 200 : 502, { ok: result.ok, data: result });
        }

        if (sub === "c2b" && id === "register" && req.method === "POST") {
          return json(200, { ok: true, data: await daraja.registerC2bUrls(readBody(req) || {}) });
        }
        if (sub === "c2b" && id === "simulate" && req.method === "POST") {
          return json(200, { ok: true, data: await daraja.c2bSimulate(readBody(req) || {}) });
        }
        if (sub === "b2c" && req.method === "POST") {
          return json(200, { ok: true, data: await daraja.b2c(readBody(req) || {}) });
        }
        if (sub === "balance" && req.method === "POST") {
          return json(200, { ok: true, data: await daraja.accountBalance(readBody(req) || {}) });
        }
        if (sub === "reversal" && req.method === "POST") {
          return json(200, { ok: true, data: await daraja.reversal(readBody(req) || {}) });
        }
        if (sub === "qr" && req.method === "POST") {
          return json(200, { ok: true, data: await daraja.dynamicQr(readBody(req) || {}) });
        }

        if (sub === "transactions" && req.method === "GET" && seg.length === 2) {
          if (!erp) return json(503, { ok: false, error: "Business suite not enabled." });
          const q = {};
          if (req.query.status) q.status = req.query.status;
          return json(200, { ok: true, data: erp.listMpesaTransactions(q) });
        }
        if (sub === "transactions" && action === "link" && req.method === "POST" && seg.length === 4) {
          if (!erp) return json(503, { ok: false, error: "Business suite not enabled." });
          const payload = readBody(req) || {};
          return json(200, { ok: true, data: erp.linkMpesaToInvoice(id, payload.invoiceId) });
        }

        return json(404, { ok: false, error: "Unknown M-Pesa endpoint." });
      }

      return json(404, { ok: false, error: "Unknown endpoint." });
    } catch (err) {
      const status = err && err.status ? err.status : 500;
      return json(status, { ok: false, error: (err && err.message) || "Server error." });
    }
  };
}

module.exports = { createApiHandler };
