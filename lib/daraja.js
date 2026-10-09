/* ==========================================================================
   Equitas Pay — Safaricom Daraja (M-Pesa) integration (zero-dependency)
   --------------------------------------------------------------------------
   Full Daraja API surface built on Node's built-in https/crypto only — no
   npm packages. Supports:

     • OAuth 2.0 access-token generation with in-memory caching
     • Lipa na M-Pesa Online (STK Push / C2B) + STK Query
     • C2B URL registration, simulation and validation/confirmation callbacks
     • B2C (Business to Customer) payments with certificate-encrypted
       SecurityCredential (RSA / PKCS#1)
     • Transaction Status, Reversal and Account Balance
     • Dynamic QR code generation
     • Phone-number normalisation to MSISDN 2547XXXXXXXX

   Configure entirely through options / environment variables. The network
   layer is injectable (`options.request`) so it can be unit-tested offline.
   ========================================================================== */
"use strict";

const https = require("https");
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");

const BASE = {
  sandbox: "https://sandbox.safaricom.co.ke",
  production: "https://api.safaricom.co.ke",
};

function httpsRequest(method, urlString, { headers = {}, body = null, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const payload =
      body == null ? null : typeof body === "string" ? body : JSON.stringify(body);
    const transport = url.protocol === "http:" ? http : https;
    const req = transport.request(
      {
        method,
        hostname: url.hostname,
        port: url.port || (url.protocol === "http:" ? 80 : 443),
        path: url.pathname + url.search,
        headers: Object.assign(
          { Accept: "application/json" },
          headers,
          payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}
        ),
        timeout,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed = data;
          try {
            parsed = data ? JSON.parse(data) : {};
          } catch (_) {
            /* non-JSON response (e.g. OAuth edge cases) — keep raw string */
          }
          resolve({ status: res.statusCode, body: parsed, raw: data });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("Daraja request timed out")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Map 07…/01…/+254…/254… to 2547XXXXXXXX (or 2541XXXXXXXX). */
function normalizePhone(input) {
  let s = String(input || "").replace(/[^\d+]/g, "");
  if (s.startsWith("+")) s = s.slice(1);
  if (s.startsWith("0")) s = "254" + s.slice(1);
  else if (s.startsWith("7") || s.startsWith("1")) s = "254" + s;
  if (!/^254(7|1)\d{8}$/.test(s)) throw new Error("Invalid Kenyan phone number: " + input);
  return s;
}

function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear() +
    p(d.getUTCMonth() + 1) +
    p(d.getUTCDate()) +
    p(d.getUTCHours()) +
    p(d.getUTCMinutes()) +
    p(d.getUTCSeconds())
  );
}

class DarajaError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = "DarajaError";
    this.status = status || 502;
    this.payload = payload;
  }
}

class Daraja {
  constructor(options = {}) {
    const env = (options.env || process.env.MPESA_ENV || "sandbox").toLowerCase();
    this.config = {
      env: env === "production" ? "production" : "sandbox",
      consumerKey: options.consumerKey || process.env.MPESA_CONSUMER_KEY || "",
      consumerSecret: options.consumerSecret || process.env.MPESA_CONSUMER_SECRET || "",
      shortcode: options.shortcode || process.env.MPESA_SHORTCODE || "",
      passkey: options.passkey || process.env.MPESA_PASSKEY || "",
      callbackUrl: options.callbackUrl || process.env.MPESA_CALLBACK_URL || "",
      // STK transaction type: CustomerPayBillOnline (Paybill) or CustomerBuyGoodsOnline (Till)
      stkTransactionType:
        options.stkTransactionType || process.env.MPESA_STK_TYPE || "CustomerPayBillOnline",
      // C2B
      c2bValidationUrl: options.c2bValidationUrl || process.env.MPESA_C2B_VALIDATION_URL || "",
      c2bConfirmationUrl: options.c2bConfirmationUrl || process.env.MPESA_C2B_CONFIRMATION_URL || "",
      responseType: options.responseType || "Completed",
      // B2C / status / reversal / balance
      initiatorName: options.initiatorName || process.env.MPESA_INITIATOR_NAME || "",
      initiatorPassword: options.initiatorPassword || process.env.MPESA_INITIATOR_PASSWORD || "",
      securityCredential: options.securityCredential || process.env.MPESA_SECURITY_CREDENTIAL || "",
      certificatePath: options.certificatePath || process.env.MPESA_CERT_PATH || "",
      certificatePem: options.certificatePem || process.env.MPESA_CERT_PEM || "",
      b2cShortcode: options.b2cShortcode || process.env.MPESA_B2C_SHORTCODE || "",
      b2cCommandId: options.b2cCommandId || process.env.MPESA_B2C_COMMAND || "BusinessPayment",
      // security
      allowedIpRanges: options.allowedIpRanges || [],
      request: options.request || httpsRequest,
    };
    this.base = options.baseUrl || BASE[this.config.env];
    this._token = null;
    this._tokenExpiresAt = 0;
  }

  get configured() {
    const c = this.config;
    return {
      env: c.env,
      base: this.base,
      hasCredentials: !!(c.consumerKey && c.consumerSecret),
      hasShortcode: !!c.shortcode,
      hasPasskey: !!c.passkey,
      hasCallback: !!c.callbackUrl,
      hasB2c: !!(c.initiatorName && (c.initiatorPassword || c.securityCredential)),
    };
  }

  require(condition, message, status = 422) {
    if (!condition) throw new DarajaError(message, status);
  }

  /* ------------------------------ OAuth -------------------------------- */

  async accessToken({ force = false } = {}) {
    const now = Date.now();
    if (!force && this._token && now < this._tokenExpiresAt) return this._token;
    this.require(
      this.config.consumerKey && this.config.consumerSecret,
      "Daraja credentials are not configured (MPESA_CONSUMER_KEY / MPESA_CONSUMER_SECRET).",
      500
    );
    const auth = Buffer.from(
      this.config.consumerKey + ":" + this.config.consumerSecret
    ).toString("base64");
    const res = await this.config.request({
      method: "GET",
      url: this.base + "/oauth/v1/generate?grant_type=client_credentials",
      headers: { Authorization: "Basic " + auth },
      body: null,
    });
    if (res.status !== 200 || !res.body || !res.body.access_token) {
      throw new DarajaError(
        "Daraja OAuth failed: " + JSON.stringify(res.body),
        res.status || 502,
        res.body
      );
    }
    this._token = res.body.access_token;
    const ttl = Number(res.body.expires_in) || 3599;
    this._tokenExpiresAt = now + (ttl - 60) * 1000;
    return this._token;
  }

  async authorizedPost(path, body) {
    const token = await this.accessToken();
    const res = await this.config.request({
      method: "POST",
      url: this.base + path,
      headers: { Authorization: "Bearer " + token },
      body,
    });
    return res;
  }

  _password() {
    this.require(this.config.shortcode && this.config.passkey, "STK Push requires MPESA_SHORTCODE and MPESA_PASSKEY.", 500);
    return Buffer.from(this.config.shortcode + this.config.passkey + timestamp()).toString("base64");
  }

  /* --------------------------- STK Push (C2B) -------------------------- */

  /**
   * Lipa na M-Pesa Online (STK Push).
   * @param {{ phone, amount, accountReference, description, callbackUrl, shortcode }} p
   */
  async stkPush(p = {}) {
    const phone = normalizePhone(p.phone);
    const amount = Math.round(Number(p.amount));
    this.require(amount > 0, "Amount must be greater than zero.");
    const callbackUrl = p.callbackUrl || this.config.callbackUrl;
    this.require(callbackUrl && /^https:\/\//i.test(callbackUrl), "A public HTTPS callback URL is required for STK Push.", 500);
    const body = {
      BusinessShortCode: String(p.shortcode || this.config.shortcode),
      Password: this._password(),
      Timestamp: timestamp(),
      TransactionType: p.transactionType || this.config.stkTransactionType,
      Amount: amount,
      PartyA: phone,
      PartyB: String(p.shortcode || this.config.shortcode),
      PhoneNumber: phone,
      CallbackURL: callbackUrl,
      AccountReference: String(p.accountReference || "Equitas").slice(0, 12),
      TransactionDesc: String(p.description || "Payment to Equitas Law").slice(0, 13),
    };
    const res = await this.authorizedPost("/mpesa/stkpush/v1/processrequest", body);
    return this._normalise(res, "MerchantRequestID");
  }

  async stkQuery({ checkoutRequestId, shortcode } = {}) {
    this.require(checkoutRequestId, "CheckoutRequestID is required.");
    const body = {
      BusinessShortCode: String(shortcode || this.config.shortcode),
      Password: this._password(),
      Timestamp: timestamp(),
      CheckoutRequestID: checkoutRequestId,
    };
    const res = await this.authorizedPost("/mpesa/stkpushquery/v1/query", body);
    return this._normalise(res);
  }

  /* ------------------------------- C2B --------------------------------- */

  async registerC2bUrls({ shortcode, validationUrl, confirmationUrl, responseType } = {}) {
    const body = {
      ShortCode: String(shortcode || this.config.shortcode),
      ResponseType: responseType || this.config.responseType,
      ConfirmationURL: confirmationUrl || this.config.c2bConfirmationUrl,
      ValidationURL: validationUrl || this.config.c2bValidationUrl,
    };
    this.require(body.ConfirmationURL, "A C2B confirmation URL is required.", 500);
    const res = await this.authorizedPost("/mpesa/c2b/v1/registerurl", body);
    return this._normalise(res);
  }

  async c2bSimulate({ phone, amount, billRefNumber, shortcode, commandId } = {}) {
    const body = {
      ShortCode: String(shortcode || this.config.shortcode),
      CommandID: commandId || "CustomerPayBillOnline",
      Amount: Math.round(Number(amount)),
      Msisdn: normalizePhone(phone),
      BillRefNumber: String(billRefNumber || "Equitas"),
    };
    const res = await this.authorizedPost("/mpesa/c2b/v1/simulate", body);
    return this._normalise(res);
  }

  /* ------------------------------- B2C --------------------------------- */

  _securityCredential() {
    if (this.config.securityCredential) return this.config.securityCredential;
    this.require(this.config.initiatorPassword, "B2C requires MPESA_INITIATOR_PASSWORD or MPESA_SECURITY_CREDENTIAL.", 500);
    const pem = this.config.certificatePem
      ? this.config.certificatePem
      : this.config.certificatePath && fs.existsSync(this.config.certificatePath)
      ? fs.readFileSync(this.config.certificatePath, "utf8")
      : null;
    this.require(pem, "A Safaricom certificate (MPESA_CERT_PEM or MPESA_CERT_PATH) is required to encrypt the SecurityCredential.", 500);
    return crypto
      .publicEncrypt(
        { key: pem, padding: crypto.constants.RSA_PKCS1_PADDING },
        Buffer.from(this.config.initiatorPassword)
      )
      .toString("base64");
  }

  async b2c({ phone, amount, remarks, occasion, commandId } = {}) {
    const body = {
      InitiatorName: this.config.initiatorName,
      SecurityCredential: this._securityCredential(),
      CommandID: commandId || this.config.b2cCommandId,
      Amount: Math.round(Number(amount)),
      PartyA: String(this.config.b2cShortcode || this.config.shortcode),
      PartyB: normalizePhone(phone),
      Remarks: String(remarks || "Equitas Law payment").slice(0, 100),
      QueueTimeOutURL: this.config.callbackUrl,
      ResultURL: this.config.callbackUrl,
      Occasion: String(occasion || "").slice(0, 100),
    };
    this.require(body.PartyA && body.Amount > 0, "B2C requires a shortcode and a positive amount.");
    const res = await this.authorizedPost("/mpesa/b2c/v1/paymentrequest", body);
    return this._normalise(res);
  }

  /* ------------------- Status / Reversal / Balance --------------------- */

  async transactionStatus({ transactionId, phone, remarks, occasion } = {}) {
    const body = {
      Initiator: this.config.initiatorName,
      SecurityCredential: this._securityCredential(),
      CommandID: "TransactionStatusQuery",
      TransactionID: transactionId || "",
      PartyA: String(this.config.shortcode),
      IdentifierType: "4",
      ResultURL: this.config.callbackUrl,
      QueueTimeOutURL: this.config.callbackUrl,
      Remarks: String(remarks || "Status query").slice(0, 100),
      Occasion: String(occasion || "").slice(0, 100),
    };
    if (phone) body.OriginatorConversationID = normalizePhone(phone);
    const res = await this.authorizedPost("/mpesa/transactionstatus/v1/query", body);
    return this._normalise(res);
  }

  async reversal({ transactionId, amount, remarks, occasion } = {}) {
    const body = {
      Initiator: this.config.initiatorName,
      SecurityCredential: this._securityCredential(),
      CommandID: "TransactionReversal",
      TransactionID: transactionId,
      Amount: Math.round(Number(amount)),
      ReceiverParty: String(this.config.shortcode),
      RecieverIdentifierType: "4",
      ResultURL: this.config.callbackUrl,
      QueueTimeOutURL: this.config.callbackUrl,
      Remarks: String(remarks || "Reversal").slice(0, 100),
      Occasion: String(occasion || "").slice(0, 100),
    };
    const res = await this.authorizedPost("/mpesa/reversal/v1/request", body);
    return this._normalise(res);
  }

  async accountBalance({ remarks } = {}) {
    const body = {
      Initiator: this.config.initiatorName,
      SecurityCredential: this._securityCredential(),
      CommandID: "AccountBalance",
      PartyA: String(this.config.shortcode),
      IdentifierType: "4",
      ResultURL: this.config.callbackUrl,
      QueueTimeOutURL: this.config.callbackUrl,
      Remarks: String(remarks || "Balance query").slice(0, 100),
      Occasion: "",
    };
    const res = await this.authorizedPost("/mpesa/accountbalance/v1/query", body);
    return this._normalise(res);
  }

  /* ------------------------------- QR ---------------------------------- */

  async dynamicQr({ merchantName, refNo, amount, trxCode, cpi, trxCodeSize } = {}) {
    const body = {
      MerchantName: String(merchantName || "Equitas Law Advocates").slice(0, 100),
      RefNo: String(refNo || "Equitas").slice(0, 100),
      Amount: Math.round(Number(amount) || 0),
      TrxCode: trxCode || "BG", // BG=Buy Goods, WA=Withdraw, PB=Paybill, SM=Send Money, SB=Send to Business
      CPI: String(cpi || this.config.shortcode),
      Size: String(trxCodeSize || ""),
    };
    const res = await this.authorizedPost("/mpesa/qrcode/v1/generate", body);
    return this._normalise(res);
  }

  /* --------------------------- Callback parsing ------------------------ */

  /**
   * Parse an STK Push callback body into a normalised result.
   * Returns { success, receipt, amount, phone, date, checkoutRequestId, resultCode, resultDesc }.
   */
  static parseStkCallback(payload = {}) {
    const stk = payload.Body && payload.Body.stkCallback;
    if (!stk) return { success: false, raw: payload, resultDesc: "Malformed callback" };
    const items = {};
    const list = (stk.CallbackMetadata && stk.CallbackMetadata.Item) || [];
    for (const item of list) items[item.Name] = item.Value;
    return {
      success: Number(stk.ResultCode) === 0,
      resultCode: stk.ResultCode,
      resultDesc: stk.ResultDesc,
      merchantRequestId: stk.MerchantRequestID,
      checkoutRequestId: stk.CheckoutRequestID,
      receipt: items.MpesaReceiptNumber || null,
      amount: items.Amount != null ? Number(items.Amount) : null,
      phone: items.PhoneNumber != null ? String(items.PhoneNumber) : null,
      date: items.TransactionDate != null ? String(items.TransactionDate) : null,
      raw: payload,
    };
  }

  /** Parse a C2B confirmation body into a normalised result. */
  static parseC2bConfirmation(payload = {}) {
    return {
      success: true,
      transactionType: payload.TransactionType,
      receipt: payload.TransID,
      amount: Number(payload.TransAmount),
      shortcode: payload.BusinessShortCode,
      accountReference: payload.BillRefNumber,
      balance: payload.OrgAccountBalance,
      phone: payload.MSISDN,
      name: [payload.FirstName, payload.MiddleName, payload.LastName].filter(Boolean).join(" ").trim(),
      transTime: payload.TransTime,
      raw: payload,
    };
  }

  _normalise(res, successKey) {
    const ok = res.status >= 200 && res.status < 300;
    const body = res.body || {};
    const hasError = body.errorCode || (body.ResponseCode && body.ResponseCode !== "0");
    return {
      ok: ok && !hasError,
      status: res.status,
      responseCode: body.ResponseCode || null,
      responseDescription: body.ResponseDescription || body.errorMessage || body.ResponseDesc || null,
      customerMessage: body.CustomerMessage || null,
      merchantRequestId: body.MerchantRequestID || null,
      checkoutRequestId: body.CheckoutRequestID || null,
      conversationId: body.ConversationID || null,
      qrCode: body.QRCode || null,
      body,
      success: !!(successKey ? body[successKey] : ok && !hasError),
    };
  }
}

module.exports = { Daraja, DarajaError, normalizePhone, timestamp, httpsRequest, BASE };
