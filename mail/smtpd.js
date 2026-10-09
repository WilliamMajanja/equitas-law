/* ==========================================================================
   Equitas Mail — zero-dependency SMTP server (RFC 5321 subset)
   --------------------------------------------------------------------------
   Pure Node.js `net` module. Receives mail for local domains and stores
   messages in EquitasDB via MailStore.

   Supported: EHLO/HELO, MAIL FROM, RCPT TO (local domains only — relaying
   is refused), DATA (dot-stuffed, size-limited), RSET, NOOP, VRFY, QUIT.
   ========================================================================== */
"use strict";

const net = require("net");
const { parseMessage, dotUnstuff } = require("./message");
const { extractAddress } = require("./store");

const MAX_MESSAGE_SIZE = 2.5 * 1024 * 1024; // 2.5 MB
const MAX_LINE = 1000; // RFC 5321 §4.5.3.1 (512 + slack)
const IDLE_TIMEOUT = 120_000;

class SMTPServer {
  /**
   * @param {MailStore} options.store
   * @param {number} options.port  Default 2525 (port 25 needs privileges).
   * @param {string} options.hostname  Banner hostname.
   */
  constructor(options) {
    if (!options || !options.store) throw new Error("SMTPServer requires a MailStore");
    this.store = options.store;
    this.hostname = options.hostname || "mail.equitaslaw.org";
    this.port = options.port !== undefined ? options.port : 2525;
    this.host = options.host || "0.0.0.0";
    this.server = null;
    this.startedAt = null;
    this.received = 0;
    this.connections = 0;
  }

  status() {
    return {
      running: !!this.server,
      port: this.port,
      hostname: this.hostname,
      domains: this.store.domains,
      startedAt: this.startedAt,
      messagesReceived: this.received,
      activeConnections: this.connections,
    };
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this._onConnection(socket));
      this.server.on("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.port = this.server.address().port; // resolves port 0 (tests)
        this.startedAt = new Date().toISOString();
        resolve(this.port);
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
  }

  _onConnection(socket) {
    this.connections++;
    const store = this.store;
    const hostname = this.hostname;

    socket.setNoDelay(true);
    socket.setTimeout(IDLE_TIMEOUT);

    let buffer = "";
    let inData = false;
    let dataLines = [];
    let dataSize = 0;
    let mailFrom = null;
    let rcptTo = [];
    let closed = false;

    const send = (line) => {
      if (!closed) socket.write(line + "\r\n");
    };
    const resetTransaction = () => {
      mailFrom = null;
      rcptTo = [];
    };

    send(`220 ${hostname} Equitas Mail — zero-dependency SMTP ready`);

    socket.on("timeout", () => {
      send("421 Idle timeout — closing connection");
      socket.end();
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      this.connections--;
      closed = true;
    });

    const finishData = () => {
      const raw = dotUnstuff(dataLines.join("\r\n"));
      inData = false;
      dataLines = [];
      const parsed = parseMessage(raw);
      let firstId = null;
      for (const rcpt of rcptTo) {
        const saved = store.saveMessage({
          mailbox: extractAddress(rcpt),
          direction: "in",
          from: extractAddress(parsed.from || mailFrom),
          to: parsed.to.length ? parsed.to : rcptTo,
          subject: parsed.subject,
          text: parsed.text,
          headers: parsed.headers,
          raw,
          messageId: parsed.messageId,
          date: new Date().toISOString(),
        });
        if (!firstId) firstId = saved._id;
      }
      this.received += rcptTo.length;
      resetTransaction();
      send(`250 OK — message accepted for delivery (id ${firstId})`);
    };

    const handleCommand = (line) => {
      const sp = line.indexOf(" ");
      const verb = (sp === -1 ? line : line.slice(0, sp)).toUpperCase();
      const arg = sp === -1 ? "" : line.slice(sp + 1).trim();

      switch (verb) {
        case "EHLO":
        case "HELO":
          if (verb === "EHLO") {
            send(`250-${hostname} greets ${arg || "you"}`);
            send(`250-8BITMIME`);
            send(`250-SIZE ${MAX_MESSAGE_SIZE}`);
            send(`250 HELP`);
          } else {
            send(`250 ${hostname}`);
          }
          return;

        case "MAIL": {
          const m = arg.match(/^FROM:\s*(<[^>]*>)/i);
          if (!m) return send("501 Syntax: MAIL FROM:<address>");
          mailFrom = m[1];
          rcptTo = [];
          return send(`250 OK`);
        }

        case "RCPT": {
          if (!mailFrom) return send("503 Bad sequence — MAIL first");
          const m = arg.match(/^TO:\s*(<[^>]+>)/i);
          if (!m) return send("501 Syntax: RCPT TO:<address>");
          const addr = extractAddress(m[1]);
          if (!this.store.isLocalAddress(addr)) {
            return send(`550 Relay denied — ${addr.split("@")[1] || "?"} is not a local domain`);
          }
          rcptTo.push(addr);
          return send(`250 OK — recipient ${addr}`);
        }

        case "DATA":
          if (!mailFrom || rcptTo.length === 0) {
            return send("503 Bad sequence — need MAIL and RCPT first");
          }
          send("354 End data with <CR><LF>.<CR><LF>");
          inData = true;
          dataLines = [];
          dataSize = 0;
          return;

        case "RSET":
          resetTransaction();
          return send("250 OK — state reset");

        case "NOOP":
          return send("250 OK");

        case "VRFY":
          return send(store.isLocalAddress(arg)
            ? `252 ${extractAddress(arg)}`
            : "552 Cannot verify");

        case "HELP":
          return send("214 Commands: EHLO HELO MAIL RCPT DATA RSET NOOP VRFY QUIT");

        case "QUIT":
          send(`221 ${hostname} closing connection — kwaheri`);
          return socket.end();

        default:
          return send("502 Command not implemented");
      }
    };

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx;
      while ((idx = buffer.search(/\r?\n/)) !== -1) {
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx).replace(/^\r?\n/, "");
        if (line.length > MAX_LINE) line = line.slice(0, MAX_LINE);

        if (inData) {
          if (line === ".") {
            finishData();
            continue;
          }
          dataSize += line.length + 2;
          if (dataSize > MAX_MESSAGE_SIZE) {
            inData = false;
            dataLines = [];
            resetTransaction();
            send("552 Message exceeds maximum size — transaction aborted");
            continue;
          }
          dataLines.push(line);
        } else if (line.trim() !== "") {
          handleCommand(line);
        }
      }
    });
  }
}

module.exports = { SMTPServer };
