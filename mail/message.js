/* ==========================================================================
   Equitas Mail — RFC 5322 message parsing & building (zero-dependency)
   ========================================================================== */
"use strict";

const crypto = require("crypto");

/** Unfold continuation lines (lines starting with SP/TAB). */
function unfoldHeaders(headerBlock) {
  const lines = headerBlock.split(/\r?\n/);
  const unfolded = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && unfolded.length) {
      unfolded[unfolded.length - 1] += " " + line.trim();
    } else {
      unfolded.push(line);
    }
  }
  return unfolded;
}

/** Parse a raw RFC 5322 message into { headers, from, to, subject, ... }. */
function parseMessage(raw) {
  const str = String(raw || "");
  const sep = str.search(/\r?\n\r?\n/);
  const headerBlock = sep === -1 ? str : str.slice(0, sep);
  let body = sep === -1 ? "" : str.slice(sep).replace(/^\r?\n\r?\n/, "");

  const headers = {};
  for (const line of unfoldHeaders(headerBlock)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (headers[name] === undefined) headers[name] = value;
  }

  const rawContentType = headers["content-type"] || "text/plain";
  let contentType = rawContentType.toLowerCase();
  let text = body;

  // Minimal MIME support: extract the text/plain part of multipart messages.
  const mp = rawContentType.match(/boundary="?([^";]+)"?/i);
  if (mp) {
    const boundary = mp[1];
    const parts = body.split("--" + boundary);
    let chosen = null;
    for (const part of parts) {
      if (/content-type:\s*text\/plain/i.test(part)) {
        chosen = part.replace(/^[\s\S]*?\r?\n\r?\n/, "").replace(/\r?\n--\s*$/, "");
        break;
      }
    }
    if (chosen === null) {
      for (const part of parts) {
        if (/content-type:\s*text\/html/i.test(part)) {
          chosen = part
            .replace(/^[\s\S]*?\r?\n\r?\n/, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          break;
        }
      }
    }
    if (chosen !== null) text = chosen.trim();
    contentType = "text/plain";
  }

  text = text.replace(/\r\n/g, "\n");

  const toField = headers["to"] || "";
  return {
    headers,
    from: headers["from"] || "",
    to: toField.split(",").map((s) => s.trim()).filter(Boolean),
    cc: (headers["cc"] || "").split(",").map((s) => s.trim()).filter(Boolean),
    subject: headers["subject"] || "(no subject)",
    date: headers["date"] || new Date().toISOString(),
    messageId: headers["message-id"] || `<${crypto.randomUUID()}@equitaslaw.org>`,
    contentType,
    text,
  };
}

function rfcDate(d = new Date()) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${days[d.getUTCDay()]}, ${d.getUTCDate()} ${months[d.getUTCMonth()]} ` +
    `${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`
  );
}

/** Sanitise a header value against CRLF injection. */
function h(value) {
  return String(value == null ? "" : value).replace(/[\r\n]+/g, " ").trim();
}

/** Build a compliant RFC 5322 message (CRLF line endings). */
function buildMessage({ from, to, cc, subject, text, messageId, date }) {
  const id = messageId || `<${crypto.randomUUID()}@equitaslaw.org>`;
  const toList = (Array.isArray(to) ? to : [to]).filter(Boolean).map(h).join(", ");
  const lines = [
    `Message-ID: ${h(id)}`,
    `Date: ${rfcDate(date ? new Date(date) : new Date())}`,
    `From: ${h(from)}`,
    `To: ${toList}`,
  ];
  if (cc && cc.length) lines.push(`Cc: ${(Array.isArray(cc) ? cc : [cc]).map(h).join(", ")}`);
  lines.push(
    `Subject: ${h(subject) || "(no subject)"}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    String(text || "").replace(/\r?\n/g, "\r\n")
  );
  return lines.join("\r\n");
}

/** Apply SMTP dot-stuffing to message data. */
function dotStuff(data) {
  return String(data)
    .replace(/\r?\n/g, "\r\n")
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? "." + line : line))
    .join("\r\n");
}

/** Reverse dot-stuffing on received DATA payload. */
function dotUnstuff(data) {
  return String(data)
    .split("\r\n")
    .map((line) => (line.startsWith("..") ? line.slice(1) : line))
    .join("\r\n");
}

module.exports = { parseMessage, buildMessage, dotStuff, dotUnstuff, rfcDate };
