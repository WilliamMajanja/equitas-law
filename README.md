# Equitas Law — Zero-Dependency Legal Services Platform

A full-service law-firm website **and practice-management platform** for
**Equitas Law** (Nairobi), built on a **fully self-contained, zero-dependency
stack**: no npm packages, no frameworks, no build step, no external services.

| Layer | Technology | Dependencies |
|---|---|---|
| Frontend | Hand-written HTML + CSS + vanilla JS | **0** |
| Web server | Pure Node.js (`http`, `fs`, `path`, `net`, `tls`, `crypto`) | **0** |
| Database | **EquitasDB** — embedded NoSQL document store | **0** |
| Mail | Built-in SMTP server + client (`mail/`) | **0** |
| Business suite | ERP · CRM · POS with Kenyan statutory compliance (`lib/erp.js`) | **0** |
| Payments | Safaricom Daraja / M-Pesa client (`lib/daraja.js`) | **0** |
| Hosting | Netlify (static + one zero-dependency serverless function) | **0** |

**Palette:** Navy Blue `#0a1a30` · Grey `#59616b / #eef0f2` · Brown `#7a5734 / #bc9570`

---

## Project structure

```
equitas-law/
├── server.js                  # Zero-dep Node server: static site + /api/* + SMTP
├── package.json               # No dependencies — scripts only
├── netlify.toml               # Publish dir, redirects, security headers
│
├── db/
│   └── equitasdb.js           # EquitasDB — zero-dep NoSQL engine
│
├── lib/
│   ├── api.js                 # Shared API handler (server + Netlify fn)
│   ├── erp.js                 # ERP · CRM · POS — Kenyan compliance engine
│   └── daraja.js              # Safaricom Daraja (M-Pesa) client
│
├── mail/
│   ├── store.js               # MailStore — mailboxes + messages on EquitasDB
│   ├── message.js             # RFC 5322 parse / build / dot-stuffing
│   ├── smtpd.js               # Inbound SMTP server (local delivery)
│   └── smtp-client.js         # Outbound SMTP client (MX lookup, STARTTLS)
│
├── data/
│   ├── seed/                  # Seed JSON (committed): practice areas, team,
│   │                          #   insights, testimonials, clients
│   └── *.json                 # Live database files (created at runtime,
│                              #   git-ignored)
│
├── public/                    # The website (Netlify publish directory)
│   ├── index.html             # Home
│   ├── about.html             # Story, values, timeline, process
│   ├── practice-areas.html    # All 8 practice areas + FAQ
│   ├── team.html              # Our Advocates
│   ├── insights.html          # Articles + DB-backed reader
│   ├── contact.html           # Consultation form → EquitasDB
│   ├── admin.html             # Chambers Console — DB, mail, business suite, M-Pesa
│   ├── privacy.html           # Privacy Policy (Data Protection Act, 2019)
│   ├── terms.html             # Terms & Disclaimer
│   ├── 404.html
│   ├── robots.txt · sitemap.xml · site.webmanifest
│   ├── .well-known/security.txt
│   └── assets/{css,js,img}
│
├── netlify/functions/
│   └── api.js                 # Serverless wrapper around the same DB + API
│
└── test/run-tests.js          # 69 zero-dep tests (node test/run-tests.js)
```

## The database — EquitasDB

`db/equitasdb.js` is a complete embedded NoSQL document database using only
Node.js built-ins:

- **Collections** of JSON documents, one atomic file per collection
  (`data/<collection>.json`, temp-file + rename writes)
- **CRUD:** `insert`, `insertMany`, `findById`, `find`, `findOne`, `count`,
  `update`, `replace`, `delete`, `drop`
- **Query operators:** `$eq $ne $gt $gte $lt $lte $in $nin $contains $regex
  $options $exists $size`, plus logical `$and $or $not` and dot-notation paths
- **Update operators:** `$set $unset $inc $push $pull`
- **Sort / skip / limit / projection**, in-memory unique/sparse indexes
- Automatic `_id`, `createdAt`, `updatedAt`; `seedFrom` / `seedObject` bootstrap

## Mail

- **`mail/smtpd.js`** — an SMTP server that accepts mail for local mailboxes
  (`EHLO`, `MAIL`, `RCPT`, `DATA`, `RSET`, `VRFY`, `QUIT`; 8BITMIME, 2.5 MB cap,
  idle timeout). Local-only: relay to external domains is refused.
- **`mail/message.js`** — RFC 5322 parser/builder with multipart text/plain
  extraction and header-injection protection.
- **`mail/smtp-client.js`** — outbound delivery via MX lookup with opportunistic
  STARTTLS and AUTH LOGIN.
- **`mail/store.js`** — mailbox credentials (scrypt), inbox, read/unread, counts.

The primary mailbox `d.i.majanja@equitaslaw.org` is provisioned automatically
(password via `EQUITAS_MAIL_PASSWORD`, default `EquitasMail#2026`, **change in
production**).

## Business suite — ERP · CRM · POS (Kenya)

`lib/erp.js` implements practice management aligned to Kenyan law:

- **CRM & KYC** — client registry, risk assessment, POCAMLA 2009 due diligence
  (beneficial ownership, PEP, source of funds), client statements.
- **Matters, time & billing** — matter numbering `EQ/YYYY/0001`, time capture,
  invoice drafts (`EQ-INV-YYYY-00001`) with 16% VAT and withholding tax
  (5% resident / 20% non-resident, Income Tax Act Cap. 470).
- **POS** — counter sales that auto-raise a paid tax invoice; end-of-day "Z".
- **Trust accounting** — client account deposits, withdrawals and transfers to
  office, with Advocates (Accounts) Rules overdraft prevention and
  reconciliation.
- **eTIMS** — KRA electronic tax-invoice payload builder + submission stub.
- **Reports** — trial balance, aged debtors, VAT return, WHT schedule, revenue
  by practice area, receivables and a compliance dashboard.
- **Fee scales** — Advocates (Remuneration) Order calculator (illustrative;
  confirm against the current Order).

All monetary values are VAT-aware and rounded to two decimals.

## Payments — Safaricom Daraja (M-Pesa)

`lib/daraja.js` is a full Daraja client with an injectable network layer
(therefore fully testable offline):

- OAuth token caching, **STK Push** (Lipa na M-Pesa Online) + query
- **C2B** URL registration & simulation
- **B2C**, **Transaction Status**, **Reversal**, **Account Balance**
- **Dynamic QR**
- Static `parseStkCallback` / `parseC2bConfirmation` helpers
- RSA `SecurityCredential` generation and `normalizePhone` (07/01/+254 → 254…)

Incoming STK and C2B callbacks are received at public endpoints
(`/api/mpos/callback/stk`, `/api/mpos/callback/c2b/{validation,confirmation}`)
and reconciled to invoices: a matching `AccountReference` = invoice number
automatically records the payment and marks the invoice paid (idempotent on the
M-Pesa receipt). Unmatched transactions can be linked manually.

### M-Pesa environment variables

| Variable | Purpose |
|---|---|
| `MPESA_ENV` | `sandbox` (default) or `production` |
| `MPESA_CONSUMER_KEY` / `MPESA_CONSUMER_SECRET` | Daraja app credentials |
| `MPESA_SHORTCODE` | Paybill / till number |
| `MPESA_PASSKEY` | STK Push passkey |
| `MPESA_CALLBACK_URL` | Public HTTPS callback for STK |
| `MPESA_C2B_VALIDATION_URL` / `MPESA_C2B_CONFIRMATION_URL` | C2B endpoints |
| `MPESA_INITIATOR_NAME` / `MPESA_INITIATOR_PASSWORD` | B2C/status/reversal |
| `MPESA_SECURITY_CREDENTIAL` | Pre-encoded credential (else generated from `MPESA_CERT_PATH` / `MPESA_CERT_PEM`) |
| `MPESA_B2C_SHORTCODE` / `MPESA_B2C_COMMAND` | B2C overrides |

## REST API

Public:

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/health` · `/api/stats` | Engine status |
| GET | `/api/practice-areas` · `/api/team` · `/api/testimonials` | Content |
| GET | `/api/insights` · `/api/insights/:slug` | Articles |
| POST | `/api/consultations` | Validated, honeypot, rate-limited |
| GET | `/api/mail/status` · `/api/mpos/status` | Mail / M-Pesa status |
| POST | `/api/mpos/callback/stk` · `/api/mpos/callback/c2b/*` | Safaricom callbacks |

Admin (header `x-admin-key`, default `equitas-admin`):

| Area | Endpoints |
|---|---|
| Consultations | `GET/PATCH/DELETE /api/consultations[/:id]`, `POST /api/query` |
| Mail | `/api/mail/mailboxes`, `/api/mail/inbox/:address`, `/api/mail/message/:id`, `POST /api/mail/send` |
| CRM | `/api/crm/clients[/:id]`, `/api/crm/clients/:id/{kyc,statement}`, `/api/crm/dashboard` |
| Matters | `/api/erp/matters[/:id]`, `/api/erp/time` |
| Billing | `/api/erp/invoices[/:id]`, `.../issue`, `.../etims`, `.../void` |
| POS | `/api/pos/payments[/:id]`, `/api/pos/takings` |
| Trust | `/api/erp/trust/{reconciliation,ledger,deposit,withdraw,transfer}` |
| Reports | `/api/erp/reports/{dashboard,trial-balance,aged-debtors,vat,wht,revenue,receivables,compliance}` |
| M-Pesa | `/api/mpos/{stkpush,stk/query,c2b/register,c2b/simulate,b2c,balance,reversal,qr,transactions[/:id/link]}` |

Override the admin key with `EQUITAS_ADMIN_KEY`.

## Run locally

```bash
node server.js          # or: npm start
# Site  → http://localhost:3000
# Admin → http://localhost:3000/admin.html   (key: equitas-admin)
# SMTP  → localhost:2525  (override with SMTP_PORT)
```

Run the test suite (69 tests, zero dependencies):

```bash
node test/run-tests.js  # or: npm test
```

## Deploy to Netlify

`netlify.toml` publishes `public/`, routes `/api/*` to the zero-dependency
serverless function `netlify/functions/api.js` (same EquitasDB engine, API
handler and Daraja client), and sets security headers.

**Option A — CLI:**

```bash
npm install -g netlify-cli   # once
netlify login                # once
netlify deploy --prod
```

**Option B — Git-based:** push to GitHub/GitLab and import in the Netlify
dashboard; settings are read from `netlify.toml`.

> Serverless note: Netlify functions run on a read-only filesystem except
> `/tmp`. EquitasDB stores runtime data in `/tmp` (persisting across warm
> invocations) and re-seeds read models at each cold start from bundled seed
> data. The inbound SMTP daemon runs only under `server.js`; for permanent
> server-side persistence and mail delivery, self-host `server.js` — the
> identical code runs anywhere Node.js runs.
