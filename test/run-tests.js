/* ==========================================================================
   Equitas Law — zero-dependency test suite
   Plain Node.js asserts. No test framework. Run: node test/run-tests.js
   ========================================================================== */
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { EquitasDB } = require("../db/equitasdb");
const { createApiHandler } = require("../lib/api");
const { MailStore } = require("../mail/store");
const { SMTPServer } = require("../mail/smtpd");
const { sendSMTP } = require("../mail/smtp-client");
const { parseMessage, buildMessage, dotStuff, dotUnstuff } = require("../mail/message");
const { ERP } = require("../lib/erp");
const { Daraja, normalizePhone, timestamp } = require("../lib/daraja");
const crypto = require("crypto");

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log("  ✔ " + name);
    })
    .catch((err) => {
      failed++;
      console.error("  ✘ " + name);
      console.error("    " + err.message);
    });
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "equitasdb-test-"));
}

(async function run() {
  console.log("\nEquitasDB engine tests\n──────────────────────");

  /* ------------------------------- CRUD --------------------------------- */
  const dir = tmpdir();
  const db = new EquitasDB(dir);
  const users = db.collection("users");

  await test("insert assigns _id and timestamps", () => {
    const doc = users.insert({ name: "Ada", age: 34, tags: ["law", "tech"] });
    assert.ok(doc._id, "missing _id");
    assert.ok(doc.createdAt && doc.updatedAt, "missing timestamps");
    assert.strictEqual(doc.name, "Ada");
  });

  await test("findById returns a copy", () => {
    const doc = users.insert({ name: "Bob", age: 41 });
    const found = users.findById(doc._id);
    assert.strictEqual(found.name, "Bob");
    found.name = "Mutated";
    assert.strictEqual(users.findById(doc._id).name, "Bob");
  });

  await test("find with equality + operators", () => {
    users.insert({ name: "Cara", age: 28 });
    users.insert({ name: "Dan", age: 52 });
    assert.strictEqual(users.find({ name: "Cara" }).length, 1);
    assert.strictEqual(users.find({ age: { $gt: 30 } }).length, 3);
    assert.strictEqual(users.find({ age: { $gte: 28, $lt: 40 } }).length, 2);
    assert.strictEqual(users.find({ name: { $in: ["Ada", "Dan"] } }).length, 2);
    assert.strictEqual(users.find({ name: { $regex: "^a" } }).length, 1); // Ada
    assert.strictEqual(users.find({ name: { $regex: "^B", $options: "i" } }).length, 1); // Bob
    assert.strictEqual(users.find({ tags: { $contains: "law" } }).length, 1);
  });

  await test("$or / $and logical operators", () => {
    const r = users.find({ $or: [{ age: { $lt: 30 } }, { name: "Bob" }] });
    assert.strictEqual(r.length, 2);
    const r2 = users.find({ $and: [{ age: { $gte: 30 } }, { age: { $lt: 50 } }] });
    assert.strictEqual(r2.length, 2);
  });

  await test("sort, skip, limit, projection", () => {
    const sorted = users.find({}, { sort: { age: -1 } });
    assert.strictEqual(sorted[0].name, "Dan");
    const page = users.find({}, { sort: { age: 1 }, skip: 1, limit: 2 });
    assert.strictEqual(page.length, 2);
    const proj = users.find({ name: "Ada" }, { projection: { age: 1 } })[0];
    assert.strictEqual(proj.age, 34);
    assert.strictEqual(proj.name, undefined);
  });

  await test("update with $set / $inc / $push / $unset", () => {
    const doc = users.findOne({ name: "Ada" });
    users.update(doc._id, { $set: { city: "Nairobi" }, $inc: { age: 1 } });
    let after = users.findById(doc._id);
    assert.strictEqual(after.city, "Nairobi");
    assert.strictEqual(after.age, 35);
    users.update(doc._id, { $push: { tags: "equity" } });
    after = users.findById(doc._id);
    assert.deepStrictEqual(after.tags, ["law", "tech", "equity"]);
    users.update(doc._id, { $unset: { city: true } });
    assert.strictEqual(users.findById(doc._id).city, undefined);
  });

  await test("delete by id and by query", () => {
    const doc = users.insert({ name: "Temp", age: 1 });
    assert.strictEqual(users.delete(doc._id).deleted, 1);
    assert.strictEqual(users.delete({ age: { $lt: 30 } }).deleted, 1); // Cara
    assert.strictEqual(users.find({ name: "Cara" }).length, 0);
  });

  await test("unique index rejects duplicates", () => {
    users.createIndex("email", { unique: true });
    users.insert({ name: "E1", email: "a@b.co" });
    assert.throws(() => users.insert({ name: "E2", email: "a@b.co" }));
  });

  await test("persistence: data survives a fresh instance", async () => {
    await db.flush();
    const db2 = new EquitasDB(dir);
    const users2 = db2.collection("users");
    assert.ok(users2.count() >= 3, "expected docs after reload");
    assert.strictEqual(users2.findOne({ name: "Bob" }).age, 41);
  });

  await test("seedFrom only fills empty collections", async () => {
    const dir3 = tmpdir();
    const seedDir = path.join(dir3, "seed");
    fs.mkdirSync(seedDir, { recursive: true });
    fs.writeFileSync(
      path.join(seedDir, "items.json"),
      JSON.stringify([{ _id: "i1", label: "seeded" }])
    );
    const db3 = new EquitasDB(path.join(dir3, "data"));
    const r1 = db3.seedFrom(seedDir);
    assert.strictEqual(r1.seeded.length, 1);
    await db3.flush();
    const r2 = db3.seedFrom(seedDir); // second run should not duplicate
    assert.strictEqual(r2.seeded.length, 0);
    assert.strictEqual(db3.collection("items").count(), 1);
  });

  console.log("\nAPI handler tests\n─────────────────");

  const dir4 = tmpdir();
  const apiDb = new EquitasDB(dir4);
  apiDb.seedFrom(path.join(__dirname, "..", "data", "seed"));
  const handle = createApiHandler(apiDb, { adminKey: "test-key" });
  const req = (method, p, body, headers) =>
    handle({
      method,
      path: p,
      query: {},
      headers: headers || {},
      body: body ? JSON.stringify(body) : "",
      ip: "127.0.0.1",
    });

  await test("GET /health", async () => {
    const r = await req("GET", "/health");
    assert.strictEqual(r.status, 200);
    assert.ok(JSON.parse(r.body).engine.includes("EquitasDB"));
  });

  await test("GET /practice-areas returns 8 seeded docs", async () => {
    const r = await req("GET", "/practice-areas");
    const data = JSON.parse(r.body).data;
    assert.strictEqual(data.length, 8);
    assert.strictEqual(data[0].slug, "litigation");
  });

  await test("GET /insights/:slug returns full article with body", async () => {
    const r = await req("GET", "/insights/succession-planning-kenyan-families");
    const a = JSON.parse(r.body).data;
    assert.strictEqual(a.title.includes("Succession"), true);
    assert.ok(Array.isArray(a.body) && a.body.length >= 4);
  });

  await test("GET /insights list omits body (projection)", async () => {
    const r = await req("GET", "/insights");
    const data = JSON.parse(r.body).data;
    assert.ok(data.length === 6);
    assert.strictEqual(data[0].body, undefined);
  });

  await test("POST /consultations validates input (422)", async () => {
    const r = await req("POST", "/consultations", { name: "X", email: "bad", message: "hi" });
    assert.strictEqual(r.status, 422);
    assert.ok(JSON.parse(r.body).fields.email);
  });

  await test("POST /consultations stores a valid request", async () => {
    const r = await req("POST", "/consultations", {
      name: "Test Client",
      email: "client@example.com",
      phone: "+254700000000",
      service: "Conveyancing & Real Estate",
      message: "I need help with a land purchase in Kiambu.",
      company: "",
    });
    assert.strictEqual(r.status, 201);
    assert.ok(JSON.parse(r.body).reference);
    assert.strictEqual(apiDb.collection("consultations").count(), 1);
  });

  await test("POST /consultations honeypot silently accepts bots", async () => {
    const r = await req("POST", "/consultations", { name: "Bot", company: "spammy" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(apiDb.collection("consultations").count(), 1); // not stored
  });

  await test("GET /consultations requires admin key", async () => {
    const denied = await req("GET", "/consultations");
    assert.strictEqual(denied.status, 401);
    const allowed = await req("GET", "/consultations", null, { "x-admin-key": "test-key" });
    assert.strictEqual(allowed.status, 200);
    assert.strictEqual(JSON.parse(allowed.body).data.length, 1);
  });

  await test("PATCH + DELETE consultation lifecycle", async () => {
    const list = JSON.parse(
      (await req("GET", "/consultations", null, { "x-admin-key": "test-key" })).body
    ).data;
    const id = list[0]._id;
    const patch = await req("PATCH", "/consultations/" + id, { status: "contacted" }, { "x-admin-key": "test-key" });
    assert.strictEqual(patch.status, 200);
    assert.strictEqual(apiDb.collection("consultations").findById(id).status, "contacted");
    const del = await req("DELETE", "/consultations/" + id, null, { "x-admin-key": "test-key" });
    assert.strictEqual(del.status, 200);
    assert.strictEqual(apiDb.collection("consultations").count(), 0);
  });

  await test("POST /query runs NoSQL queries (admin)", async () => {
    const r = await req(
      "POST",
      "/query",
      { collection: "team", query: { role: { $regex: "Partner" } } },
      { "x-admin-key": "test-key" }
    );
    const body = JSON.parse(r.body);
    assert.strictEqual(body.ok, true);
    assert.ok(body.count >= 2);
  });

  await test("rate limiter kicks in after 6 posts", async () => {
    let last;
    for (let i = 0; i < 7; i++) {
      last = await req("POST", "/consultations", {
        name: "Rate Tester",
        email: "r@example.com",
        message: "testing the fixed window limiter",
      });
    }
    assert.strictEqual(last.status, 429);
  });

  console.log("\nMail subsystem tests\n───────────────────");

  await test("RFC 5322: build → parse round-trips headers and body", () => {
    const raw = buildMessage({
      from: "Alice <alice@equitaslaw.org>",
      to: ["bob@example.com", "cara@example.com"],
      subject: "Deed of transfer",
      text: "Line one\nLine two",
    });
    const parsed = parseMessage(raw);
    assert.strictEqual(parsed.subject, "Deed of transfer");
    assert.strictEqual(parsed.from, "Alice <alice@equitaslaw.org>");
    assert.deepStrictEqual(parsed.to, ["bob@example.com", "cara@example.com"]);
    assert.strictEqual(parsed.text, "Line one\nLine two");
    assert.ok(parsed.messageId.includes("@equitaslaw.org"));
  });

  await test("RFC 5322: multipart picks the text/plain part", () => {
    const raw = [
      "From: a@equitaslaw.org",
      "To: b@equitaslaw.org",
      "Subject: multi",
      "Content-Type: multipart/alternative; boundary=XYZ",
      "",
      "--XYZ",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "plain text body",
      "--XYZ",
      "Content-Type: text/html",
      "",
      "<p>html body</p>",
      "--XYZ--",
    ].join("\r\n");
    const parsed = parseMessage(raw);
    assert.strictEqual(parsed.text, "plain text body");
  });

  await test("dot-stuffing round-trips leading dots", () => {
    const body = ".hidden\r\n..double\r\nnormal";
    const stuffed = dotStuff(body);
    assert.strictEqual(dotUnstuff(stuffed), body);
    assert.ok(stuffed.startsWith("..hidden"));
  });

  const mailDir = tmpdir();
  const mailDb = new EquitasDB(mailDir);
  const store = new MailStore(mailDb, { domains: ["equitaslaw.org"] });

  await test("MailStore: provisions a mailbox and hashes the password", () => {
    const r = store.provisionMailbox({
      address: "d.i.majanja@equitaslaw.org",
      name: "D.I. Majanja",
      password: "s3cret",
    });
    assert.strictEqual(r.created, true);
    const again = store.provisionMailbox({ address: "d.i.majanja@equitaslaw.org", password: "x" });
    assert.strictEqual(again.created, false);
    const stored = mailDb.collection("mailboxes").findOne({ address: "d.i.majanja@equitaslaw.org" });
    assert.ok(stored.passwordHash && !("password" in stored));
    assert.strictEqual(store.authenticateMailbox("d.i.majanja@equitaslaw.org", "s3cret"), true);
    assert.strictEqual(store.authenticateMailbox("d.i.majanja@equitaslaw.org", "wrong"), false);
  });

  await test("MailStore: local-domain checks reject external relay", () => {
    assert.strictEqual(store.isLocalAddress("a@equitaslaw.org"), true);
    assert.strictEqual(store.isLocalAddress("a@gmail.com"), false);
    assert.strictEqual(store.isLocalDomain("equitaslaw.org"), true);
    assert.strictEqual(store.isLocalDomain("example.com"), false);
  });

  await test("MailStore: save, list, mark read, delete lifecycle", () => {
    const saved = store.saveMessage({
      mailbox: "d.i.majanja@equitaslaw.org",
      direction: "in",
      from: "client@example.com",
      to: ["d.i.majanja@equitaslaw.org"],
      subject: "Consultation",
      text: "Please advise.",
    });
    assert.strictEqual(store.inbox("d.i.majanja@equitaslaw.org").length, 1);
    assert.strictEqual(store.listMailboxes()[0].unread, 1);
    store.markRead(saved._id, true);
    assert.strictEqual(store.listMailboxes()[0].unread, 0);
    assert.strictEqual(store.getMessage(saved._id).subject, "Consultation");
    assert.strictEqual(store.deleteMessage(saved._id).deleted, 1);
    assert.strictEqual(store.inbox("d.i.majanja@equitaslaw.org").length, 0);
  });

  const smtpd = new SMTPServer({ store, port: 0 });
  let smtpPort = 0;

  await test("SMTPD: starts on an ephemeral port", async () => {
    smtpPort = await smtpd.start();
    assert.ok(smtpPort > 0);
    assert.strictEqual(smtpd.status().running, true);
  });

  /** Drive a raw SMTP session, sending each line and collecting reply codes.
   *  After a 354 (DATA) reply the remaining script lines are flushed at once,
   *  since the server does not acknowledge individual body lines. */
  function rawSession(port, script) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1");
      let buffer = "";
      const replies = [];
      const queue = script.slice();
      const sendNext = () => {
        const next = queue.shift();
        if (next === undefined) {
          socket.end();
          return;
        }
        socket.write(next + "\r\n");
      };
      const drain = () => {
        let idx;
        while ((idx = buffer.indexOf("\r\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const m = line.match(/^(\d{3})([ -])(.*)$/);
          if (!m || m[2] !== " ") continue; // skip multi-line continuations
          const code = parseInt(m[1], 10);
          replies.push(code);
          if (code === 354) {
            const rest = queue.splice(0);
            if (rest.length) socket.write(rest.join("\r\n") + "\r\n");
          } else {
            sendNext();
          }
        }
      };
      socket.setTimeout(5000);
      socket.on("data", (c) => { buffer += c.toString("utf8"); drain(); });
      socket.on("close", () => resolve(replies));
      socket.on("error", reject);
      socket.on("timeout", () => { socket.destroy(); reject(new Error("raw session timeout")); });
    });
  }

  await test("SMTPD: rejects an external RCPT (relay denied 550)", async () => {
    const codes = await rawSession(smtpPort, [
      "EHLO tester",
      "MAIL FROM:<alice@equitaslaw.org>",
      "RCPT TO:<stranger@gmail.com>",
      "QUIT",
    ]);
    assert.ok(codes.includes(550), "expected 550 relay denied");
  });

  await test("SMTPD: accepts local mail via raw session and stores it", async () => {
    const before = store.inbox("d.i.majanja@equitaslaw.org").length;
    const codes = await rawSession(smtpPort, [
      "EHLO tester",
      "MAIL FROM:<alice@equitaslaw.org>",
      "RCPT TO:<D.I.Majanja@equitaslaw.org>",
      "DATA",
      "Subject: Raw socket test",
      "",
      "Hello from a raw SMTP client.",
      ".",
      "QUIT",
    ]);
    assert.ok(codes.includes(250), "expected 250 acceptance");
    const box = store.inbox("d.i.majanja@equitaslaw.org");
    assert.strictEqual(box.length, before + 1);
    assert.strictEqual(box[0].subject, "Raw socket test");
  });

  await test("SMTP client → local smtpd round-trip delivers", async () => {
    const before = store.inbox("d.i.majanja@equitaslaw.org").length;
    const result = await sendSMTP({
      from: "counsel@equitaslaw.org",
      to: "d.i.majanja@equitaslaw.org",
      subject: "Outbound round-trip",
      text: "Sent through the zero-dependency SMTP client.",
      host: "127.0.0.1",
      port: smtpPort,
      starttls: false,
    });
    assert.strictEqual(result.ok, true);
    const box = store.inbox("d.i.majanja@equitaslaw.org");
    assert.strictEqual(box.length, before + 1);
    assert.strictEqual(box[0].subject, "Outbound round-trip");
  });

  await test("SMTPD: status reports messages received", () => {
    assert.ok(smtpd.status().messagesReceived >= 2);
  });

  await smtpd.stop();

  /* --------------------------- mail API ---------------------------------- */
  const mailApiDb = new EquitasDB(tmpdir());
  mailApiDb.seedFrom(path.join(__dirname, "..", "data", "seed"));
  const apiStore = new MailStore(mailApiDb, { domains: ["equitaslaw.org"] });
  apiStore.provisionMailbox({
    address: "d.i.majanja@equitaslaw.org",
    name: "D.I. Majanja",
    password: "mail-pass",
  });
  const mailHandle = createApiHandler(mailApiDb, {
    adminKey: "test-key",
    notifyMailbox: "d.i.majanja@equitaslaw.org",
    mail: {
      store: apiStore,
      status: () => ({ running: false, serverless: true, port: null, domains: apiStore.domains }),
      // no sendOutbound → external sends should 502
    },
  });
  const mreq = (method, p, body, headers) =>
    mailHandle({
      method,
      path: p,
      query: {},
      headers: headers || {},
      body: body ? JSON.stringify(body) : "",
      ip: "10.0.0.9",
    });
  const admin = { "x-admin-key": "test-key" };

  await test("GET /mail/status is public and reports the mailbox count", async () => {
    const r = await mreq("GET", "/mail/status");
    assert.strictEqual(r.status, 200);
    const body = JSON.parse(r.body);
    assert.strictEqual(body.mailboxes.mailboxes, 1);
  });

  await test("GET /mail/mailboxes requires the admin key", async () => {
    assert.strictEqual((await mreq("GET", "/mail/mailboxes")).status, 401);
    const r = await mreq("GET", "/mail/mailboxes", null, admin);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(JSON.parse(r.body).data[0].address, "d.i.majanja@equitaslaw.org");
  });

  await test("POST /consultations drops a notification into the mailbox", async () => {
    const before = apiStore.inbox("d.i.majanja@equitaslaw.org").length;
    const r = await mreq("POST", "/consultations", {
      name: "Jane Client",
      email: "jane@example.com",
      phone: "+254711000333",
      service: "Family Law",
      message: "I would like advice on a separation agreement.",
      company: "",
    });
    assert.strictEqual(r.status, 201);
    const box = apiStore.inbox("d.i.majanja@equitaslaw.org");
    assert.strictEqual(box.length, before + 1);
    assert.ok(box[0].subject.includes("New consultation"));
    assert.ok(box[0].text.includes("Jane Client"));
  });

  await test("GET /mail/inbox + message read marks it read", async () => {
    const list = JSON.parse((await mreq("GET", "/mail/inbox/d.i.majanja@equitaslaw.org", null, admin)).body).data;
    assert.ok(list.length >= 1);
    const unread = list.find((m) => !m.read);
    assert.ok(unread, "expected an unread notification");
    const msg = JSON.parse((await mreq("GET", "/mail/message/" + unread._id, null, admin)).body).data;
    assert.strictEqual(msg._id, unread._id);
    assert.strictEqual(apiStore.getMessage(unread._id).read, true);
  });

  await test("DELETE /mail/message removes it", async () => {
    const list = JSON.parse((await mreq("GET", "/mail/inbox/d.i.majanja@equitaslaw.org", null, admin)).body).data;
    const id = list[0]._id;
    const r = await mreq("DELETE", "/mail/message/" + id, null, admin);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(apiStore.getMessage(id), null);
  });

  await test("POST /mail/send delivers locally (to + from copies)", async () => {
    const r = await mreq(
      "POST",
      "/mail/send",
      { from: "d.i.majanja@equitaslaw.org", to: "associate@equitaslaw.org", subject: "Internal", text: "Memo body" },
      admin
    );
    assert.strictEqual(r.status, 201);
    assert.strictEqual(JSON.parse(r.body).delivered, "local");
    assert.strictEqual(apiStore.inbox("associate@equitaslaw.org").length, 1);
    assert.ok(apiStore.inbox("d.i.majanja@equitaslaw.org").some((m) => m.direction === "out"));
  });

  await test("POST /mail/send returns 502 for external mail without a relay", async () => {
    const r = await mreq(
      "POST",
      "/mail/send",
      { to: "somebody@gmail.com", subject: "External", text: "This needs MX relay." },
      admin
    );
    assert.strictEqual(r.status, 502);
  });

  console.log("\nERP · CRM · POS tests (Kenya compliance)\n────────────────────────────────────────");

  const bizDb = new EquitasDB(tmpdir());
  const erp = new ERP(bizDb, { receivedBy: "tester" });

  await test("CRM: createClient validates and de-duplicates email", () => {
    const c = erp.createClient({
      name: "Zawadi Ltd",
      type: "company",
      email: "ops@zawadi.co.ke",
      pin: "P011122233W",
    });
    assert.ok(c._id);
    assert.strictEqual(c.kycStatus, "pending");
    assert.throws(
      () => erp.createClient({ name: "Clone", email: "ops@zawadi.co.ke" }),
      /already exists/
    );
    assert.throws(() => erp.createClient({ name: "Bad PIN", email: "x@y.co", pin: "123" }), /KRA PIN/);
  });

  await test("CRM: KYC verification records documents and PEP raises risk", () => {
    const c = erp.createClient({ name: "PEP Person", email: "pep@example.com", pep: true });
    assert.strictEqual(c.riskAssessment.rating, "high");
    const verified = erp.verifyKyc(c._id, {
      status: "verified",
      documents: [{ name: "National ID", reference: "11223344" }],
    });
    assert.strictEqual(verified.kycStatus, "verified");
    assert.strictEqual(verified.kycDocuments.length, 1);
  });

  const matterClient = erp.createClient({ name: "Mwangi Holdings", email: "info@mwangi.co.ke", type: "company" });

  await test("Matters: openMatter assigns a sequential matter number", () => {
    const m1 = erp.openMatter({ clientId: matterClient._id, title: "Land dispute" });
    const m2 = erp.openMatter({ clientId: matterClient._id, title: "Contract review" });
    assert.match(m1.matterNumber, /^EQ\/\d{4}\/0001$/);
    assert.match(m2.matterNumber, /^EQ\/\d{4}\/0002$/);
  });

  await test("Time: logTime computes amount from minutes × rate", () => {
    const m = erp.listMatters()[0];
    const t = erp.logTime({ matterId: m._id, minutes: 90, rate: 8000, activity: "Research" });
    assert.strictEqual(t.hours, 1.5);
    assert.strictEqual(t.amount, 12000);
    assert.strictEqual(t.invoiced, false);
  });

  const theMatter = () => erp.listMatters({ clientId: matterClient._id })[0];

  await test("Invoicing: VAT 16% + WHT 5% for a company client", () => {
    const inv = erp.createInvoiceFromTime(theMatter()._id, { applyWht: true });
    assert.strictEqual(inv.subtotal, 12000);
    assert.strictEqual(inv.vatTotal, 1920); // 16%
    assert.strictEqual(inv.total, 13920);
    assert.strictEqual(inv.whtAmount, 600); // 5%
    assert.strictEqual(inv.netReceivable, 13320);
    assert.strictEqual(inv.status, "draft");
  });

  await test("Invoicing: issue assigns eTIMS-compliant number + control code", () => {
    const draft = erp.listInvoices({ status: "draft" })[0];
    const issued = erp.issueInvoice(draft._id);
    assert.match(issued.invoiceNumber, /^EQ-INV-\d{4}-\d{5}$/);
    assert.strictEqual(issued.etims.status, "submitted");
    assert.ok(issued.etims.controlCode.includes(issued.invoiceNumber));
    // Linked time entry is now flagged as invoiced.
    assert.strictEqual(erp.listTime({ matterId: theMatter()._id })[0].invoiced, true);
  });

  await test("POS: payment settles the invoice and issues a receipt", () => {
    const inv = erp.listInvoices({ status: "issued" })[0];
    const pay = erp.recordPayment({ invoiceId: inv._id, amount: inv.total, method: "mpesa" });
    assert.match(pay.receiptNumber, /^EQ-RCT-\d{4}-\d{5}$/);
    assert.strictEqual(erp.getInvoice(inv._id).status, "paid");
    assert.strictEqual(erp.getInvoice(inv._id).balance, 0);
  });

  await test("POS: over-payment is rejected", () => {
    const c = erp.createClient({ name: "Overpay Co", email: "overpay@example.com" });
    const inv = erp.issueInvoice(erp.createInvoice({ clientId: c._id, lines: [{ description: "Fee", unitPrice: 1000 }] })._id);
    assert.throws(() => erp.recordPayment({ invoiceId: inv._id, amount: 9999 }), /exceeds/);
  });

  await test("POS: counter sale auto-raises a paid eTIMS invoice", () => {
    const pay = erp.recordPayment({
      clientName: "Walk-in Client",
      amount: 2500,
      method: "cash",
      description: "Document certification",
    });
    const inv = erp.getInvoice(pay.invoiceId);
    assert.strictEqual(inv.status, "paid");
    assert.ok(inv.invoiceNumber, "counter sale needs a tax-invoice number");
    assert.strictEqual(erp.dailyTakings().total >= 2500, true);
  });

  await test("Trust: deposits, withdrawals and overdraft prevention", () => {
    erp.trustDeposit({ clientId: matterClient._id, amount: 50000, reference: "RTGS-001" });
    assert.strictEqual(erp.trustBalance(matterClient._id), 50000);
    erp.trustWithdraw({ clientId: matterClient._id, amount: 20000, purpose: "Court filing fees" });
    assert.strictEqual(erp.trustBalance(matterClient._id), 30000);
    assert.throws(
      () => erp.trustWithdraw({ clientId: matterClient._id, amount: 40000, purpose: "Too much" }),
      /Insufficient trust funds/
    );
    const recon = erp.trustReconciliation();
    assert.strictEqual(recon.compliant, true);
    assert.strictEqual(recon.overdrawn, 0);
  });

  await test("Trust: settle an invoice from client money (trust → office)", () => {
    const c = erp.createClient({ name: "Trust Client", email: "trust@example.com" });
    erp.trustDeposit({ clientId: c._id, amount: 30000 });
    const inv = erp.issueInvoice(
      erp.createInvoice({ clientId: c._id, lines: [{ description: "Conveyancing", unitPrice: 20000 }] })._id
    );
    const payment = erp.trustTransferToOffice({ invoiceId: inv._id, amount: inv.total });
    assert.strictEqual(erp.getInvoice(inv._id).status, "paid");
    assert.strictEqual(erp.trustBalance(c._id), round(30000 - inv.total));
    assert.match(payment.receiptNumber, /^EQ-RCT-/);
  });

  await test("Expenses + VAT return (output vs input VAT)", () => {
    erp.recordExpense({ category: "rent", amount: 116000, vatAmount: 16000, description: "Office rent", paidTo: "Landlord Ltd" });
    const vat = erp.vatReturn();
    assert.ok(vat.outputVat > 0);
    assert.strictEqual(vat.inputVat, 16000);
    assert.strictEqual(vat.netVatPayable, round(vat.outputVat - 16000));
  });

  await test("Reports: trial balance, aged debtors, WHT schedule, compliance", () => {
    const tb = erp.trialBalance();
    assert.ok(tb.totals.debit > 0 && tb.totals.credit > 0);
    const aged = erp.agedDebtors();
    assert.ok("current" in aged && "d90plus" in aged);
    const wht = erp.whtSchedule();
    assert.ok(wht.total > 0);
    const compliance = erp.compliance();
    assert.ok(compliance.statutes.some((s) => s.act.includes("VAT")));
    assert.ok(compliance.statutes.some((s) => s.act.includes("Advocates (Accounts)")));
  });

  await test("Fee scale: Advocates (Remuneration) Order calculation", () => {
    const fee = erp.computeScaleFee(3000000, "conveyancing");
    assert.strictEqual(fee.fee, 60000); // 2% bracket
    assert.ok(fee.note.includes("Remuneration"));
  });

  /* ------------------- business suite API endpoints ---------------------- */
  const bizApiDb = new EquitasDB(tmpdir());
  bizApiDb.seedFrom(path.join(__dirname, "..", "data", "seed"));
  const apiErp = new ERP(bizApiDb, { receivedBy: "api" });
  const bizHandle = createApiHandler(bizApiDb, { adminKey: "test-key", erp: apiErp });
  const breq = (method, p, body, headers) =>
    bizHandle({
      method,
      path: p,
      query: {},
      headers: headers || {},
      body: body ? JSON.stringify(body) : "",
      ip: "192.168.1.5",
    });
  const badmin = { "x-admin-key": "test-key" };

  await test("ERP API: seeded clients are available and admin-gated", async () => {
    assert.strictEqual((await breq("GET", "/crm/clients")).status, 401);
    const r = await breq("GET", "/crm/clients", null, badmin);
    assert.strictEqual(r.status, 200);
    assert.ok(JSON.parse(r.body).data.length >= 3);
  });

  await test("ERP API: full CRM → matter → invoice → payment flow", async () => {
    const client = JSON.parse(
      (await breq("POST", "/crm/clients", { name: "Api Test Ltd", type: "company", email: "api@test.co.ke" }, badmin)).body
    ).data;
    const matter = JSON.parse(
      (await breq("POST", "/erp/matters", { clientId: client._id, title: "API matter" }, badmin)).body
    ).data;
    await breq("POST", "/erp/time", { matterId: matter._id, minutes: 60, rate: 10000 }, badmin);
    const invoice = JSON.parse(
      (await breq("POST", "/erp/invoices", { matterId: matter._id, fromTime: true, applyWht: true }, badmin)).body
    ).data;
    assert.strictEqual(invoice.subtotal, 10000);
    const issued = JSON.parse((await breq("POST", `/erp/invoices/${invoice._id}/issue`, null, badmin)).body).data;
    assert.ok(issued.invoiceNumber);
    const pay = await breq("POST", "/pos/payments", { invoiceId: invoice._id, amount: invoice.total, method: "card" }, badmin);
    assert.strictEqual(pay.status, 201);
  });

  await test("ERP API: reports and compliance endpoints", async () => {
    const dash = JSON.parse((await breq("GET", "/erp/reports/dashboard", null, badmin)).body).data;
    assert.ok(dash.clients >= 4);
    const comp = JSON.parse((await breq("GET", "/erp/reports/compliance", null, badmin)).body).data;
    assert.ok(Array.isArray(comp.statutes));
    const trust = JSON.parse((await breq("GET", "/erp/trust/reconciliation", null, badmin)).body).data;
    assert.strictEqual(trust.compliant, true);
  });

  await test("ERP API: website consultation creates a CRM client", async () => {
    const before = apiErp.clients.count();
    await breq("POST", "/consultations", {
      name: "CRM Enquiry",
      email: "crm.enquiry@example.com",
      message: "I need help with a company formation.",
      company: "",
    });
    assert.strictEqual(apiErp.clients.count(), before + 1);
    assert.ok(apiErp.clients.findOne({ email: "crm.enquiry@example.com" }));
  });

  console.log("\nM-Pesa (Safaricom Daraja) tests\n───────────────────────────────");

  await test("Daraja: normalizePhone accepts 07xx / +254 / 254 forms", () => {
    assert.strictEqual(normalizePhone("0712345678"), "254712345678");
    assert.strictEqual(normalizePhone("+254712345678"), "254712345678");
    assert.strictEqual(normalizePhone("254712345678"), "254712345678");
    assert.strictEqual(normalizePhone("0110000000"), "254110000000");
    assert.throws(() => normalizePhone("12345"), /Invalid Kenyan phone/);
  });

  await test("Daraja: timestamp is YYYYMMDDHHmmss (UTC)", () => {
    const ts = timestamp(new Date(Date.UTC(2026, 0, 9, 14, 5, 7)));
    assert.strictEqual(ts, "20260109140507");
  });

  function darajaMock(capture) {
    return async (req) => {
      capture.push(req);
      if (req.url.includes("/oauth/v1/generate")) {
        return { status: 200, body: { access_token: "TESTTOKEN", expires_in: 3599 } };
      }
      if (req.url.includes("/stkpush/v1/processrequest")) {
        return {
          status: 200,
          body: {
            MerchantRequestID: "MERCH-1",
            CheckoutRequestID: "CHECK-1",
            ResponseCode: "0",
            ResponseDescription: "Success",
            CustomerMessage: "Enter PIN",
          },
        };
      }
      if (req.url.includes("/qrcode/v1/generate")) {
        return { status: 200, body: { ResponseCode: "00", QRCode: "iVBORw0KGgo=" } };
      }
      return { status: 200, body: { ResponseCode: "0", ResponseDescription: "OK" } };
    };
  }

  const darajaCalls = [];
  const daraja = new Daraja({
    env: "sandbox",
    consumerKey: "key",
    consumerSecret: "secret",
    shortcode: "174379",
    passkey: "testpass",
    callbackUrl: "https://equitaslaw.org/api/mpos/callback/stk",
    request: darajaMock(darajaCalls),
  });

  await test("Daraja: OAuth token is cached across calls", async () => {
    const t1 = await daraja.accessToken();
    const t2 = await daraja.accessToken();
    assert.strictEqual(t1, "TESTTOKEN");
    assert.strictEqual(t2, "TESTTOKEN");
    const oauthCalls = darajaCalls.filter((c) => c.url.includes("/oauth/"));
    assert.strictEqual(oauthCalls.length, 1, "token should be fetched once");
  });

  await test("Daraja: STK Push builds a valid request and returns request IDs", async () => {
    const before = darajaCalls.length;
    const res = await daraja.stkPush({
      phone: "0712345678",
      amount: 1500,
      accountReference: "EQ-INV-2026-00001",
      description: "Fees",
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.checkoutRequestId, "CHECK-1");
    const call = darajaCalls.slice(before).find((c) => c.url.includes("processrequest"));
    assert.ok(call.headers.Authorization.startsWith("Bearer TESTTOKEN"));
    assert.strictEqual(call.body.Amount, 1500);
    assert.strictEqual(call.body.PhoneNumber, "254712345678");
    assert.strictEqual(call.body.BusinessShortCode, "174379");
    assert.ok(call.body.Password, "STK password must be present");
  });

  await test("Daraja: STK Push requires a public HTTPS callback", async () => {
    const noCallback = new Daraja({ consumerKey: "k", consumerSecret: "s", shortcode: "1", passkey: "p", request: darajaMock([]) });
    await assert.rejects(
      () => noCallback.stkPush({ phone: "0712345678", amount: 100 }),
      /HTTPS callback/
    );
  });

  await test("Daraja: decryptable RSA SecurityCredential for B2C", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pub = publicKey.export({ type: "pkcs1", format: "pem" });
    const d = new Daraja({
      shortcode: "600000",
      initiatorName: "testapi",
      initiatorPassword: "Safaricom#999",
      certificatePem: pub,
      request: darajaMock([]),
    });
    const credential = d._securityCredential();
    assert.ok(credential.length > 100);
    const decrypted = crypto
      .privateDecrypt(
        { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
        Buffer.from(credential, "base64")
      )
      .toString("utf8");
    assert.strictEqual(decrypted, "Safaricom#999");
  });

  await test("Daraja: parses a successful STK callback", () => {
    const parsed = Daraja.parseStkCallback({
      Body: {
        stkCallback: {
          MerchantRequestID: "M1",
          CheckoutRequestID: "C1",
          ResultCode: 0,
          ResultDesc: "The service request is processed successfully.",
          CallbackMetadata: {
            Item: [
              { Name: "Amount", Value: 1500 },
              { Name: "MpesaReceiptNumber", Value: "QK12345678" },
              { Name: "TransactionDate", Value: 20260109140507 },
              { Name: "PhoneNumber", Value: 254712345678 },
            ],
          },
        },
      },
    });
    assert.strictEqual(parsed.success, true);
    assert.strictEqual(parsed.receipt, "QK12345678");
    assert.strictEqual(parsed.amount, 1500);
    assert.strictEqual(parsed.phone, "254712345678");
  });

  await test("Daraja: parses a failed STK callback", () => {
    const parsed = Daraja.parseStkCallback({
      Body: { stkCallback: { CheckoutRequestID: "C2", ResultCode: 1032, ResultDesc: "Request cancelled by user" } },
    });
    assert.strictEqual(parsed.success, false);
    assert.strictEqual(parsed.resultCode, 1032);
  });

  await test("Daraja: parses a C2B confirmation", () => {
    const c = Daraja.parseC2bConfirmation({
      TransactionType: "Pay Bill",
      TransID: "QK99887766",
      TransAmount: "2500.00",
      BillRefNumber: "EQ-INV-2026-00001",
      MSISDN: "254712345678",
      FirstName: "Jane",
      LastName: "Doe",
    });
    assert.strictEqual(c.receipt, "QK99887766");
    assert.strictEqual(c.amount, 2500);
    assert.strictEqual(c.name, "Jane Doe");
  });

  await test("ERP: M-Pesa transaction auto-reconciles to an invoice", () => {
    const c = erp.createClient({ name: "Mpesa Client", email: "mpesa@example.com" });
    const inv = erp.issueInvoice(
      erp.createInvoice({ clientId: c._id, lines: [{ description: "Fee", unitPrice: 5000 }] })._id
    );
    const tx = erp.recordMpesaTransaction({
      receipt: "QK55667788",
      amount: inv.total,
      phone: "254712345678",
      accountReference: inv.invoiceNumber,
      channel: "stk",
    });
    assert.strictEqual(tx.status, "reconciled");
    assert.strictEqual(erp.getInvoice(inv._id).status, "paid");
    // Idempotent: replaying the same receipt does not double-post.
    const replay = erp.recordMpesaTransaction({ receipt: "QK55667788", amount: inv.total, accountReference: inv.invoiceNumber });
    assert.strictEqual(replay.duplicate, true);
    assert.strictEqual(erp.listMpesaTransactions({ receipt: "QK55667788" }).length, 1);
  });

  await test("ERP: unmatched M-Pesa transaction can be linked manually", () => {
    const c = erp.createClient({ name: "Late Match", email: "latematch@example.com" });
    const inv = erp.issueInvoice(erp.createInvoice({ clientId: c._id, lines: [{ description: "Fee", unitPrice: 1000 }] })._id);
    const tx = erp.recordMpesaTransaction({ receipt: "QK00001111", amount: inv.total, accountReference: "UNKNOWN" });
    assert.strictEqual(tx.status, "unmatched");
    const linked = erp.linkMpesaToInvoice(tx._id, inv._id);
    assert.strictEqual(linked.status, "reconciled");
    assert.strictEqual(erp.getInvoice(inv._id).status, "paid");
  });

  await test("Daraja API: status, STK Push and public STK callback flow", async () => {
    const mpayDb = new EquitasDB(tmpdir());
    const mpayErp = new ERP(mpayDb, { receivedBy: "mpos" });
    const mockCalls = [];
    const mpayDaraja = new Daraja({
      consumerKey: "k",
      consumerSecret: "s",
      shortcode: "174379",
      passkey: "p",
      callbackUrl: "https://equitaslaw.org/api/mpos/callback/stk",
      request: darajaMock(mockCalls),
    });
    const handle = createApiHandler(mpayDb, { adminKey: "test-key", erp: mpayErp, daraja: mpayDaraja });
    const call = (method, p, body, headers) =>
      handle({ method, path: p, query: {}, headers: headers || {}, body: body ? JSON.stringify(body) : "", ip: "10.0.0.1" });
    const adm = { "x-admin-key": "test-key" };

    const status = await call("GET", "/mpos/status", null, adm);
    assert.strictEqual(status.status, 200);
    assert.strictEqual(JSON.parse(status.body).data.hasCredentials, true);

    const client = mpayErp.createClient({ name: "STK Client", email: "stk@example.com" });
    const inv = mpayErp.issueInvoice(
      mpayErp.createInvoice({ clientId: client._id, lines: [{ description: "Fee", unitPrice: 1500 }] })._id
    );

    const push = await call("POST", "/mpos/stkpush", { invoiceId: inv._id, phone: "0712345678" }, adm);
    assert.strictEqual(push.status, 200);
    assert.strictEqual(JSON.parse(push.body).data.checkoutRequestId, "CHECK-1");
    assert.strictEqual(mpayErp.listMpesaTransactions({ status: "pending" }).length, 1);

    // Safaricom posts the callback (no admin key needed).
    const cb = await call("POST", "/mpos/callback/stk", {
      Body: {
        stkCallback: {
          MerchantRequestID: "MERCH-1",
          CheckoutRequestID: "CHECK-1",
          ResultCode: 0,
          ResultDesc: "ok",
          CallbackMetadata: {
            Item: [
              { Name: "Amount", Value: inv.total },
              { Name: "MpesaReceiptNumber", Value: "QK12121212" },
              { Name: "TransactionDate", Value: 20260109140507 },
              { Name: "PhoneNumber", Value: 254712345678 },
            ],
          },
        },
      },
    });
    assert.strictEqual(JSON.parse(cb.body).ResultCode, 0);
    assert.strictEqual(mpayErp.getInvoice(inv._id).status, "paid");
    assert.strictEqual(mpayErp.listMpesaTransactions({ status: "reconciled" }).length, 1);
    assert.strictEqual(mpayErp.listMpesaTransactions({ status: "pending" }).length, 0);
  });

  console.log("\n──────────────────────────────");
  console.log(`Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);

  function round(n) {
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }
})();
