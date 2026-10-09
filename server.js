/* ==========================================================================
   Equitas Law — zero-dependency web server
   --------------------------------------------------------------------------
   Pure Node.js (built-in http/fs/path only). Serves the static site from
   /public and a REST API at /api/* backed by EquitasDB — our zero-dependency
   NoSQL document database. No npm install required. Run:  node server.js
   ========================================================================== */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { EquitasDB } = require("./db/equitasdb");
const { createApiHandler } = require("./lib/api");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = process.env.EQUITAS_DATA_DIR || path.join(ROOT, "data");
const SEED_DIR = path.join(DATA_DIR, "seed");
const ADMIN_KEY = process.env.EQUITAS_ADMIN_KEY || "equitas-admin";

/* ------------------------- database bootstrap ---------------------------- */
const db = new EquitasDB(DATA_DIR);
const seeded = db.seedFrom(SEED_DIR);
if (seeded.seeded.length) {
  console.log(
    "[equitasdb] seeded:",
    seeded.seeded.map((s) => `${s.collection}(${s.count})`).join(", ")
  );
}
const handleApi = createApiHandler(db, { adminKey: ADMIN_KEY });

/* ------------------------------ MIME types -------------------------------- */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
};

/* --------------------------- security headers ------------------------------ */
function securityHeaders(extra) {
  return Object.assign(
    {
      "x-content-type-options": "nosniff",
      "x-frame-options": "SAMEORIGIN",
      "referrer-policy": "strict-origin-when-cross-origin",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
    },
    extra || {}
  );
}

/* ------------------------------ body reader -------------------------------- */
function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/* ------------------------------ static files ------------------------------- */
function safeJoin(base, urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const target = path.normalize(path.join(base, decoded));
  if (!target.startsWith(base)) return null; // path traversal guard
  return target;
}

function serveStatic(req, res, urlPath) {
  let filePath = safeJoin(PUBLIC_DIR, urlPath === "/" ? "/index.html" : urlPath);
  if (!filePath) {
    res.writeHead(403, securityHeaders());
    return res.end("Forbidden");
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // Extensionless pretty URLs: /about -> /about.html
    if (!path.extname(filePath) && fs.existsSync(filePath + ".html")) {
      filePath += ".html";
    } else {
      const notFound = path.join(PUBLIC_DIR, "404.html");
      res.writeHead(404, securityHeaders({ "content-type": MIME[".html"] }));
      return res.end(fs.existsSync(notFound) ? fs.readFileSync(notFound) : "Not Found");
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  const cacheable = [".css", ".js", ".svg", ".png", ".jpg", ".woff2", ".ico"].includes(ext);
  res.writeHead(
    200,
    securityHeaders({
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": cacheable ? "public, max-age=86400" : "no-cache",
    })
  );
  fs.createReadStream(filePath).pipe(res);
}

/* -------------------------------- server ----------------------------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (pathname === "/api" || pathname.startsWith("/api/")) {
    try {
      const body =
        req.method === "POST" || req.method === "PATCH" || req.method === "PUT"
          ? await readBody(req)
          : "";
      const query = Object.fromEntries(url.searchParams.entries());
      const result = await handleApi({
        method: req.method,
        path: pathname.replace(/^\/api/, "") || "/",
        query,
        headers: req.headers,
        body,
        ip: req.socket.remoteAddress,
      });
      res.writeHead(result.status, securityHeaders(result.headers));
      return res.end(result.body);
    } catch (err) {
      res.writeHead(500, securityHeaders({ "content-type": MIME[".json"] }));
      return res.end(JSON.stringify({ ok: false, error: "Internal server error." }));
    }
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, securityHeaders());
    return res.end("Method Not Allowed");
  }
  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log("");
  console.log("  ┌─────────────────────────────────────────────────────┐");
  console.log("  │   EQUITAS LAW — zero-dependency stack is running    │");
  console.log("  ├─────────────────────────────────────────────────────┤");
  console.log(`  │   Site      →  http://localhost:${PORT}               `);
  console.log(`  │   API       →  http://localhost:${PORT}/api/health    `);
  console.log(`  │   Admin     →  http://localhost:${PORT}/admin.html    `);
  console.log(`  │   Admin key →  ${ADMIN_KEY}                         `);
  console.log(`  │   Database  →  ${DATA_DIR}`);
  console.log("  └─────────────────────────────────────────────────────┘");
  console.log("");
});
