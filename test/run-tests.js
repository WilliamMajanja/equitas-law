/* ==========================================================================
   Equitas Law — zero-dependency test suite
   Plain Node.js asserts. No test framework. Run: node test/run-tests.js
   ========================================================================== */
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EquitasDB } = require("../db/equitasdb");
const { createApiHandler } = require("../lib/api");

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

  console.log("\n──────────────────────────────");
  console.log(`Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
