/* ==========================================================================
   Equitas Mail — zero-dependency SMTP client (outbound)
   --------------------------------------------------------------------------
   Pure Node.js: net / tls / dns. Sends mail either to an explicit host:port
   or by resolving the recipient domain's MX records (dns.resolveMx).
   Supports STARTTLS upgrade and AUTH LOGIN when credentials are supplied.
   ========================================================================== */
"use strict";

const net = require("net");
const tls = require("tls");
const dns = require("dns").promises;
const { buildMessage, dotStuff } = require("./message");
const { extractAddress } = require("./store");

/** Minimal line-oriented SMTP dialog driver. */
class SMTPDialog {
  constructor(socket, timeout = 20000) {
    this.socket = socket;
    this.buffer = "";
    this.waiters = [];
    socket.setTimeout(timeout);
    socket.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      this._pump();
    });
    socket.on("error", (err) => this._fail(err));
    socket.on("timeout", () => this._fail(new Error("SMTP dialog timeout")));
  }

  _fail(err) {
    const w = this.waiters.splice(0);
    w.forEach((wfn) => wfn.reject(err));
  }

  _pump() {
    if (!this.waiters.length) return;
    // A complete SMTP reply: one or more "NNN-text" lines, ending "NNN text".
    const lines = this.buffer.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(\d{3})([ -])(.*)$/);
      if (m && m[2] === " ") {
        const reply = {
          code: parseInt(m[1], 10),
          lines: lines.slice(0, i + 1).filter((l) => /^\d{3}[ -]/.test(l)),
        };
        this.buffer = lines.slice(i + 1).join("\r\n");
        const w = this.waiters.shift();
        if (w) w.resolve(reply);
        if (this.waiters.length) this._pump();
        return;
      }
    }
  }

  read() {
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this._pump();
    });
  }

  async command(line, expect) {
    if (line !== null) this.socket.write(line + "\r\n");
    const reply = await this.read();
    if (expect && reply.code !== expect) {
      throw new Error(`SMTP ${reply.code}: ${reply.lines.join(" | ")}`);
    }
    return reply;
  }
}

async function resolveMxHosts(domain) {
  try {
    const mx = await dns.resolveMx(domain);
    if (mx && mx.length) {
      return mx.sort((a, b) => a.priority - b.priority).map((r) => r.exchange);
    }
  } catch (_) {
    /* fall through to A-record */
  }
  return [domain]; // RFC 5321: fall back to A/AAAA
}

/**
 * Send an email via SMTP.
 *
 * @param {object} opts
 *   from, to (string|string[]), subject, text
 *   host, port      — explicit server (skip MX); port 25 default
 *   secure          — implicit TLS (port 465 style)
 *   starttls        — attempt STARTTLS upgrade when offered (default true)
 *   auth            — { user, pass } enables AUTH LOGIN
 *   timeout         — ms per step
 */
async function sendSMTP(opts) {
  const toList = (Array.isArray(opts.to) ? opts.to : [opts.to]).map(extractAddress);
  const from = extractAddress(opts.from);
  if (!from || !toList.length) throw new Error("sendSMTP requires from and to");

  let hosts;
  if (opts.host) {
    hosts = [{ host: opts.host, port: opts.port || 25 }];
  } else {
    const domain = toList[0].split("@")[1];
    hosts = (await resolveMxHosts(domain)).map((h) => ({ host: h, port: opts.port || 25 }));
  }

  const message = buildMessage({
    from: opts.from,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
  });

  let lastError = null;
  for (const { host, port } of hosts) {
    let socket = null;
    try {
      socket = opts.secure
        ? tls.connect({ host, port, servername: host })
        : net.connect({ host, port });
      await new Promise((res, rej) => {
        socket.once(opts.secure ? "secureConnect" : "connect", res);
        socket.once("error", rej);
      });

      const dialog = new SMTPDialog(socket, opts.timeout || 20000);
      await dialog.command(null, 220); // greeting

      const ehlo = await dialog.command(`EHLO equitaslaw.org`);
      const caps = ehlo.lines.join("\n").toUpperCase();

      if (!opts.secure && opts.starttls !== false && caps.includes("STARTTLS")) {
        await dialog.command("STARTTLS", 220);
        socket = tls.connect({ socket, servername: host });
        await new Promise((res, rej) => {
          socket.once("secureConnect", res);
          socket.once("error", rej);
        });
        dialog.socket = socket;
        socket.on("data", (chunk) => {
          dialog.buffer += chunk.toString("utf8");
          dialog._pump();
        });
        await dialog.command("EHLO equitaslaw.org");
      }

      if (opts.auth && opts.auth.user) {
        await dialog.command("AUTH LOGIN", 334);
        await dialog.command(Buffer.from(opts.auth.user).toString("base64"), 334);
        await dialog.command(Buffer.from(opts.auth.pass || "").toString("base64"), 235);
      }

      await dialog.command(`MAIL FROM:<${from}>`, 250);
      for (const rcpt of toList) await dialog.command(`RCPT TO:<${rcpt}>`, 250);
      await dialog.command("DATA", 354);
      const accepted = await dialog.command(dotStuff(message) + "\r\n.", null);
      await dialog.command("QUIT");
      socket.end();

      return {
        ok: accepted.code === 250,
        server: `${host}:${port}`,
        response: accepted.lines[accepted.lines.length - 1] || "",
        messageId: message.match(/^Message-ID:\s*(.+)$/m)?.[1] || null,
      };
    } catch (err) {
      lastError = err;
      if (socket) socket.destroy();
    }
  }
  throw lastError || new Error("No MX hosts available");
}

module.exports = { sendSMTP };
