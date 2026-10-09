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

/**
 * @param {EquitasDB} db
 * @param {{ adminKey: string }} options
 */
function createApiHandler(db, options) {
  const adminKey = options.adminKey || "equitas-admin";
  const allowConsultation = createRateLimiter(6, 10 * 60 * 1000); // 6 per 10 min

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

      return json(404, { ok: false, error: "Unknown endpoint." });
    } catch (err) {
      return json(500, { ok: false, error: "Server error: " + err.message });
    }
  };
}

module.exports = { createApiHandler };
