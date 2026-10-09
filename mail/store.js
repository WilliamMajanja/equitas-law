/* ==========================================================================
   Equitas Mail — mail store (zero-dependency)
   --------------------------------------------------------------------------
   Mailboxes and messages are EquitasDB collections, so the mail server needs
   no external database. Mailbox credentials are hashed with scrypt (Node
   built-in crypto). Messages are RFC 5322 documents stored per mailbox.
   ========================================================================== */
"use strict";

const crypto = require("crypto");

const ADDRESS_RE = /^[a-zA-Z0-9._%+'-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

/** Extract bare address from an RFC 5322 mailbox ("Name <a@b>" | "a@b"). */
function extractAddress(value) {
  if (!value) return "";
  const str = String(value).trim();
  const angle = str.match(/<([^>]+)>/);
  return (angle ? angle[1] : str).trim().toLowerCase();
}

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 32).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(expectedHash, "hex"));
}

class MailStore {
  /**
   * @param {EquitasDB} db
   * @param {{ domains?: string[] }} options Local domains this server accepts mail for.
   */
  constructor(db, options = {}) {
    this.db = db;
    this.domains = (options.domains || ["equitaslaw.org"]).map((d) => d.toLowerCase());
    this.messages = db.collection("messages");
    this.mailboxes = db.collection("mailboxes");
    this.messages.createIndex("mailbox");
    try {
      this.mailboxes.createIndex("address", { unique: true });
    } catch (_) {
      /* index may already exist on a warm collection */
    }
  }

  isLocalDomain(domain) {
    return this.domains.includes(String(domain || "").toLowerCase());
  }

  isLocalAddress(address) {
    const addr = extractAddress(address);
    const domain = addr.split("@")[1];
    return ADDRESS_RE.test(addr) && this.isLocalDomain(domain);
  }

  /** Create a mailbox if absent. Returns { address, created }. */
  provisionMailbox({ address, name, password }) {
    const addr = extractAddress(address);
    if (!ADDRESS_RE.test(addr)) throw new Error("Invalid mailbox address: " + address);
    if (!this.isLocalAddress(addr)) throw new Error("Not a local domain: " + addr);
    const existing = this.mailboxes.findOne({ address: addr });
    if (existing) return { address: addr, created: false };
    const { salt, hash } = hashPassword(password || crypto.randomBytes(9).toString("base64url"));
    this.mailboxes.insert({
      address: addr,
      name: name || addr.split("@")[0],
      passwordSalt: salt,
      passwordHash: hash,
    });
    return { address: addr, created: true };
  }

  authenticateMailbox(address, password) {
    const box = this.mailboxes.findOne({ address: extractAddress(address) });
    if (!box) return false;
    return verifyPassword(password, box.passwordSalt, box.passwordHash);
  }

  listMailboxes() {
    return this.mailboxes
      .find({}, { projection: { passwordHash: 0, passwordSalt: 0 }, sort: { address: 1 } })
      .map((b) => ({
        ...b,
        unread: this.messages.count({ mailbox: b.address, read: false, direction: "in" }),
        total: this.messages.count({ mailbox: b.address }),
      }));
  }

  /**
   * Persist a message for a mailbox.
   * direction: "in" (received) | "out" (sent copy)
   */
  saveMessage({ mailbox, direction = "in", from, to, subject, text, headers, raw, messageId, date, read }) {
    const addr = extractAddress(mailbox);
    const size = raw ? Buffer.byteLength(raw, "utf8") : Buffer.byteLength(text || "", "utf8");
    return this.messages.insert({
      mailbox: addr,
      direction,
      from: from || "",
      to: Array.isArray(to) ? to : [to].filter(Boolean),
      subject: subject || "(no subject)",
      text: text || "",
      headers: headers || {},
      raw: raw || null,
      messageId: messageId || `<${crypto.randomUUID()}@${addr.split("@")[1]}>`,
      date: date || new Date().toISOString(),
      read: direction === "out" ? true : !!read,
      size,
    });
  }

  inbox(address, { limit = 100, unreadOnly = false } = {}) {
    const addr = extractAddress(address);
    const query = { mailbox: addr };
    if (unreadOnly) query.read = false;
    return this.messages.find(query, {
      sort: { date: -1 },
      limit,
      projection: { raw: 0 },
    });
  }

  getMessage(id) {
    return this.messages.findById(id);
  }

  markRead(id, read = true) {
    return this.messages.update(id, { $set: { read: !!read } });
  }

  deleteMessage(id) {
    return this.messages.delete(id);
  }

  counts() {
    return {
      mailboxes: this.mailboxes.count(),
      messages: this.messages.count(),
      unread: this.messages.count({ read: false, direction: "in" }),
    };
  }
}

module.exports = { MailStore, extractAddress, hashPassword, verifyPassword };
