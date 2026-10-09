# Equitas Law — Zero-Dependency Legal Services Website

A full-service law-firm website for **Equitas Law** (Nairobi), built to the same
structure as D.I. Majanja Advocates — with a **fully self-contained,
zero-dependency stack**: no npm packages, no frameworks, no build step, no
external services.

| Layer | Technology | Dependencies |
|---|---|---|
| Frontend | Hand-written HTML + CSS + vanilla JS | **0** |
| Web server | Pure Node.js (`http`, `fs`, `path`) | **0** |
| Database | **EquitasDB** — embedded NoSQL document store (`fs`, `crypto`) | **0** |
| Hosting | Netlify (static + one zero-dependency serverless function) | **0** |

**Palette:** Navy Blue `#0a1a30` · Grey `#59616b / #eef0f2` · Brown `#7a5734 / #bc9570`

---

## Project structure

```
equitas-law/
├── server.js                  # Zero-dep Node server: static site + /api/*
├── package.json               # No dependencies — scripts only
├── netlify.toml               # Publish dir, redirects, security headers
│
├── db/
│   └── equitasdb.js           # EquitasDB — zero-dep NoSQL engine
│
├── lib/
│   └── api.js                 # Shared API handler (server + Netlify fn)
│
├── data/
│   ├── seed/                  # Seed JSON (committed): practice areas, team,
│   │                          #   insights articles, testimonials
│   └── *.json                 # Live database files (created at runtime,
│                              #   git-ignored)
│
├── public/                    # The website (Netlify publish directory)
│   ├── index.html             # Home — hero, trust strip, practice preview,
│   │                          #   about preview, stats, testimonials, CTA
│   ├── about.html             # Story, values, timeline, process
│   ├── practice-areas.html    # All 8 practice areas + FAQ
│   ├── team.html              # Our Advocates
│   ├── insights.html          # Articles + DB-backed article reader overlay
│   ├── contact.html           # Consultation form → stored in EquitasDB
│   ├── admin.html             # Chambers Console — DB dashboard + query console
│   ├── 404.html
│   └── assets/{css,js,img}    # Design system, interactions, favicon
│
├── netlify/functions/
│   └── api.js                 # Serverless wrapper around the same DB + API
│
└── test/run-tests.js          # 21 zero-dep tests (node test/run-tests.js)
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
- **Sort / skip / limit / projection**
- **In-memory secondary indexes** (unique & sparse-aware)
- Automatic `_id`, `createdAt`, `updatedAt`; collection stats
- `seedFrom(dir)` / `seedObject(map)` for bootstrap data

```js
const { EquitasDB } = require("./db/equitasdb");
const db = new EquitasDB("./data");

db.collection("consultations").insert({ name: "Jane", service: "Conveyancing" });
db.collection("team").find({ role: { $regex: "Partner" } }, { sort: { order: 1 } });
db.collection("insights").update("in-off-plan", { $inc: { views: 1 } });
```

## REST API

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/health` | Engine status |
| GET | `/api/stats` | Collection stats |
| GET | `/api/practice-areas` | All practice areas |
| GET | `/api/team` | Advocates |
| GET | `/api/insights` · `/api/insights/:slug` | Articles (list omits body) |
| GET | `/api/testimonials` | Client voices |
| POST | `/api/consultations` | Submit consultation (validated, honeypot, rate-limited) |
| GET | `/api/consultations` 🔑 | List submissions |
| PATCH | `/api/consultations/:id` 🔑 | Update status |
| DELETE | `/api/consultations/:id` 🔑 | Delete |
| POST | `/api/query` 🔑 | Run arbitrary NoSQL queries |

🔑 = requires header `x-admin-key` (default `equitas-admin`, override with the
`EQUITAS_ADMIN_KEY` environment variable).

## Run locally

```bash
node server.js          # or: npm start
# Site  → http://localhost:3000
# Admin → http://localhost:3000/admin.html   (key: equitas-admin)
```

Run the test suite (21 tests, zero dependencies):

```bash
node test/run-tests.js  # or: npm test
```

## Deploy to Netlify

The repo is fully prepared — `netlify.toml` publishes `public/`, routes
`/api/*` to the zero-dependency serverless function `netlify/functions/api.js`
(which runs the same EquitasDB engine + API handler), and sets security
headers. No environment variables are required (optionally set
`EQUITAS_ADMIN_KEY`).

**Option A — CLI (one command):**

```bash
npm install -g netlify-cli   # once
netlify login                # once (browser approval)
cd equitas-law
netlify deploy --prod        # add --alias equitas-law for a named URL
```

**Option B — Git-based (continuous deployment):**

Push this repo to GitHub/GitLab, then in the Netlify dashboard:
**Add new site → Import an existing project**. Build settings are read from
`netlify.toml` automatically — no build command needed.

> Note on serverless persistence: Netlify functions run on a read-only
> filesystem except `/tmp`. EquitasDB therefore stores runtime data in `/tmp`
> (persisting across warm invocations) and re-seeds read models
> (practice areas, team, insights, testimonials) at every cold start from the
> bundled seed data. Consultation submissions live for the lifetime of the warm
> instance. For permanent server-side persistence, self-host `server.js` —
> the identical code runs anywhere Node.js runs.
