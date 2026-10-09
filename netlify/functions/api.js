/* ==========================================================================
   Netlify Function — /api/* for Equitas Law (zero-dependency)
   --------------------------------------------------------------------------
   Reuses the exact same stack as the self-hosted server:
     • EquitasDB (db/equitasdb.js)   — zero-dependency NoSQL database
     • createApiHandler (lib/api.js) — shared API logic
   Netlify functions run on a read-only filesystem except /tmp, so the
   database directory lives in /tmp and is seeded at cold start from the
   bundled data/seed JSON files. Consultations persist for the lifetime of
   the warm function instance; the read models (practice areas, team,
   insights, testimonials) are always available from seed.
   ========================================================================== */
"use strict";

const path = require("path");
const { EquitasDB } = require("../../db/equitasdb");
const { createApiHandler } = require("../../lib/api");

/* Seed documents are require()d so the Netlify bundler traces and packages
   them deterministically (fs.readFile of data files is not traceable). */
const SEED = {
  "practice-areas": require("../../data/seed/practice-areas.json"),
  team: require("../../data/seed/team.json"),
  insights: require("../../data/seed/insights.json"),
  testimonials: require("../../data/seed/testimonials.json"),
};

const DATA_DIR = process.env.EQUITAS_DATA_DIR || path.join("/tmp", "equitasdb");
const ADMIN_KEY = process.env.EQUITAS_ADMIN_KEY || "equitas-admin";

/* Reuse one DB + handler across warm invocations (cold-start singleton). */
let handlerPromise = null;
function getHandler() {
  if (!handlerPromise) {
    handlerPromise = (async () => {
      const db = new EquitasDB(DATA_DIR);
      db.seedObject(SEED);
      await db.flush();
      return createApiHandler(db, { adminKey: ADMIN_KEY });
    })();
  }
  return handlerPromise;
}

exports.handler = async (event) => {
  const handleApi = await getHandler();
  const result = await handleApi({
    method: event.httpMethod,
    path: (event.path || "/").replace(/^\/\.netlify\/functions\/api/, "").replace(/^\/api/, "") || "/",
    query: event.queryStringParameters || {},
    headers: event.headers || {},
    body: event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf8")
      : event.body || "",
    ip: (event.headers && (event.headers["x-nf-client-connection-ip"] || event.headers["client-ip"])) || "netlify",
  });
  return {
    statusCode: result.status,
    headers: result.headers,
    body: result.body,
  };
};
