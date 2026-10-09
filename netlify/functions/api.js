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
const { MailStore } = require("../../mail/store");
const { ERP } = require("../../lib/erp");
const { Daraja } = require("../../lib/daraja");

/* Seed documents are require()d so the Netlify bundler traces and packages
   them deterministically (fs.readFile of data files is not traceable). */
const SEED = {
  "practice-areas": require("../../data/seed/practice-areas.json"),
  team: require("../../data/seed/team.json"),
  insights: require("../../data/seed/insights.json"),
  testimonials: require("../../data/seed/testimonials.json"),
  clients: require("../../data/seed/clients.json"),
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
      const mailStore = new MailStore(db, { domains: ["equitaslaw.org"] });
      mailStore.provisionMailbox({
        address: "d.i.majanja@equitaslaw.org",
        name: "D.I. Majanja",
        password: process.env.EQUITAS_MAIL_PASSWORD || "EquitasMail#2026",
      });
      const erp = new ERP(db, {
        receivedBy: "netlify",
        config: { seller: { pin: process.env.EQUITAS_KRA_PIN || "P051234567X" } },
      });
      const daraja = new Daraja({ env: process.env.MPESA_ENV || "sandbox" });
      await db.flush();
      return createApiHandler(db, {
        adminKey: ADMIN_KEY,
        notifyMailbox: "d.i.majanja@equitaslaw.org",
        erp,
        daraja,
        mail: {
          store: mailStore,
          // Serverless runtimes cannot bind raw TCP ports — no SMTP daemon
          // and no outbound relay here; local mailbox delivery still works.
          status: () => ({ running: false, serverless: true, port: null, domains: mailStore.domains }),
        },
      });
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
