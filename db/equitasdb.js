/* ==========================================================================
   EquitasDB — a zero-dependency NoSQL document database engine
   --------------------------------------------------------------------------
   Pure Node.js. Uses only built-in modules: fs, path, crypto.
   No npm packages, no external services, no build step.

   Features
     • Collections of JSON documents persisted to disk (one file per
       collection, atomic writes via temp-file + rename)
     • CRUD: insert, insertMany, findById, find, findOne, count, update,
       replace, delete, drop
     • Mongo-style query operators:
         $eq $ne $gt $gte $lt $lte $in $nin $contains $regex $exists $size
       with dot-notation paths ("address.city")
     • Logical operators: $and $or $not
     • Update operators: $set $unset $inc $push $pull
     • Sort, skip, limit, projection
     • Secondary in-memory indexes (unique or non-unique)
     • Timestamps (_id, createdAt, updatedAt) and collection stats
   ========================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/* ----------------------------- helpers ---------------------------------- */

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function getPath(obj, dottedPath) {
  if (!dottedPath) return obj;
  const parts = String(dottedPath).split(".");
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

function setPath(obj, dottedPath, value) {
  const parts = String(dottedPath).split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!isPlainObject(current[part]) && !Array.isArray(current[part])) {
      current[part] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    }
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

function unsetPath(obj, dottedPath) {
  const parts = String(dottedPath).split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    current = current[parts[i]];
    if (current === null || current === undefined) return;
  }
  if (isPlainObject(current) || Array.isArray(current)) {
    delete current[parts[parts.length - 1]];
  }
}

/* --------------------------- query matching ------------------------------ */

function matchOperator(actual, operator, expected) {
  switch (operator) {
    case "$eq":
      return JSON.stringify(actual) === JSON.stringify(expected);
    case "$ne":
      return JSON.stringify(actual) !== JSON.stringify(expected);
    case "$gt":
      return actual > expected;
    case "$gte":
      return actual >= expected;
    case "$lt":
      return actual < expected;
    case "$lte":
      return actual <= expected;
    case "$in":
      return Array.isArray(expected) && expected.some((v) =>
        JSON.stringify(v) === JSON.stringify(actual) ||
        (Array.isArray(actual) && actual.some((a) => JSON.stringify(a) === JSON.stringify(v)))
      );
    case "$nin":
      return !matchOperator(actual, "$in", expected);
    case "$contains":
      if (typeof actual === "string") return actual.includes(String(expected));
      if (Array.isArray(actual)) {
        return actual.some((v) => JSON.stringify(v) === JSON.stringify(expected));
      }
      return false;
    case "$regex": {
      if (typeof actual !== "string") return false;
      const re = expected instanceof RegExp ? expected : new RegExp(expected, "i");
      return re.test(actual);
    }
    case "$exists":
      return expected ? actual !== undefined : actual === undefined;
    case "$size":
      return Array.isArray(actual) && actual.length === expected;
    default:
      throw new Error(`Unsupported query operator: ${operator}`);
  }
}

function matchCondition(doc, field, condition) {
  const actual = getPath(doc, field);
  if (isPlainObject(condition)) {
    const keys = Object.keys(condition);
    const isOperatorDoc = keys.some((k) => k.startsWith("$"));
    if (isOperatorDoc) {
      return keys.every((op) => {
        if (op === "$options") return true; // consumed together with $regex
        if (op === "$regex") {
          if (typeof actual !== "string") return false;
          const flags =
            typeof condition.$options === "string" ? condition.$options : "i";
          const re =
            condition.$regex instanceof RegExp
              ? condition.$regex
              : new RegExp(condition.$regex, flags);
          return re.test(actual);
        }
        return matchOperator(actual, op, condition[op]);
      });
    }
  }
  return JSON.stringify(actual) === JSON.stringify(condition);
}

function matchQuery(doc, query) {
  if (!query || Object.keys(query).length === 0) return true;
  return Object.entries(query).every(([field, condition]) => {
    if (field === "$and") {
      if (!Array.isArray(condition)) throw new Error("$and requires an array");
      return condition.every((q) => matchQuery(doc, q));
    }
    if (field === "$or") {
      if (!Array.isArray(condition)) throw new Error("$or requires an array");
      return condition.some((q) => matchQuery(doc, q));
    }
    if (field === "$not") {
      return !matchQuery(doc, condition);
    }
    return matchCondition(doc, field, condition);
  });
}

/* ------------------------------ sorting ---------------------------------- */

function applySort(docs, sort) {
  if (!sort) return docs;
  const fields = Array.isArray(sort) ? sort : Object.entries(sort); // { field: 1 | -1 }
  const pairs = fields.map((entry) =>
    Array.isArray(entry) ? entry : [entry, 1]
  );
  return docs.slice().sort((a, b) => {
    for (const [field, dir] of pairs) {
      const va = getPath(a, field);
      const vb = getPath(b, field);
      if (va === vb) continue;
      if (va === undefined) return 1;
      if (vb === undefined) return -1;
      const cmp = va > vb ? 1 : -1;
      return dir === -1 || dir === "desc" ? -cmp : cmp;
    }
    return 0;
  });
}

function applyProjection(doc, projection) {
  if (!projection) return doc;
  const entries = Object.entries(projection);
  const includeMode = entries.some(([, v]) => v === 1 || v === true);
  if (includeMode) {
    const out = { _id: doc._id };
    for (const [field, v] of entries) {
      if ((v === 1 || v === true) && field !== "_id") {
        const value = getPath(doc, field);
        if (value !== undefined) setPath(out, field, clone(value));
      }
    }
    if (projection._id === 0) delete out._id;
    return out;
  }
  const out = clone(doc);
  for (const [field, v] of entries) {
    if (v === 0 || v === false) unsetPath(out, field);
  }
  return out;
}

/* ------------------------------ updates ---------------------------------- */

function applyUpdate(doc, update) {
  const isOperatorDoc =
    isPlainObject(update) && Object.keys(update).some((k) => k.startsWith("$"));

  if (!isOperatorDoc) {
    // Replacement-style merge for plain objects (shallow at top level paths)
    const next = clone(doc);
    for (const [field, value] of Object.entries(update)) {
      if (field === "_id") continue;
      setPath(next, field, clone(value));
    }
    return next;
  }

  const next = clone(doc);
  for (const [op, fields] of Object.entries(update)) {
    switch (op) {
      case "$set":
        for (const [field, value] of Object.entries(fields)) {
          if (field === "_id") continue;
          setPath(next, field, clone(value));
        }
        break;
      case "$unset":
        for (const field of Object.keys(fields)) unsetPath(next, field);
        break;
      case "$inc":
        for (const [field, value] of Object.entries(fields)) {
          const current = getPath(next, field) || 0;
          if (typeof current !== "number" || typeof value !== "number") {
            throw new Error(`$inc requires numeric values (${field})`);
          }
          setPath(next, field, current + value);
        }
        break;
      case "$push":
        for (const [field, value] of Object.entries(fields)) {
          let arr = getPath(next, field);
          if (arr === undefined) {
            arr = [];
            setPath(next, field, arr);
          }
          if (!Array.isArray(arr)) throw new Error(`$push target is not an array (${field})`);
          arr.push(clone(value));
        }
        break;
      case "$pull":
        for (const [field, value] of Object.entries(fields)) {
          const arr = getPath(next, field);
          if (!Array.isArray(arr)) continue;
          setPath(
            next,
            field,
            arr.filter((item) => !matchCondition(item, "", value) &&
              JSON.stringify(item) !== JSON.stringify(value))
          );
        }
        break;
      default:
        throw new Error(`Unsupported update operator: ${op}`);
    }
  }
  return next;
}

/* ------------------------------ Collection -------------------------------- */

class Collection {
  constructor(db, name) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new Error(`Invalid collection name: ${name}`);
    }
    this.db = db;
    this.name = name;
    this.file = path.join(db.dir, `${name}.json`);
    this.docs = new Map(); // _id -> document
    this.indexes = new Map(); // field -> { unique, map: value -> Set(_id) }
    this._load();
  }

  _load() {
    if (!fs.existsSync(this.file)) return;
    const raw = fs.readFileSync(this.file, "utf8");
    if (!raw.trim()) return;
    const parsed = JSON.parse(raw);
    const docs = Array.isArray(parsed) ? parsed : parsed.documents || [];
    for (const doc of docs) {
      this.docs.set(doc._id, doc);
    }
  }

  _persist() {
    this.db._persistCollection(this);
  }

  _rebuildIndexes() {
    for (const [field, idx] of this.indexes) {
      idx.map.clear();
      for (const doc of this.docs.values()) {
        this._indexDoc(field, idx, doc);
      }
    }
  }

  _indexDoc(field, idx, doc) {
    const value = getPath(doc, field);
    // Sparse semantics for unique indexes: docs missing the field are skipped.
    if (idx.unique && (value === undefined || value === null)) return;
    const key = JSON.stringify(value === undefined ? null : value);
    if (!idx.map.has(key)) idx.map.set(key, new Set());
    if (idx.unique && idx.map.get(key).size > 0) {
      throw new Error(`Duplicate key for unique index "${field}"`);
    }
    idx.map.get(key).add(doc._id);
  }

  _unindexDoc(field, idx, doc) {
    const value = getPath(doc, field);
    const key = JSON.stringify(value === undefined ? null : value);
    const bucket = idx.map.get(key);
    if (bucket) {
      bucket.delete(doc._id);
      if (bucket.size === 0) idx.map.delete(key);
    }
  }

  /** Create an in-memory secondary index on a field. */
  createIndex(field, options = {}) {
    const idx = { unique: !!options.unique, map: new Map() };
    this.indexes.set(field, idx);
    for (const doc of this.docs.values()) this._indexDoc(field, idx, doc);
    return { field, unique: idx.unique, size: idx.map.size };
  }

  dropIndex(field) {
    return this.indexes.delete(field);
  }

  /** Insert a single document. Returns the inserted document. */
  insert(doc) {
    if (!isPlainObject(doc)) throw new Error("Can only insert plain objects");
    const now = new Date().toISOString();
    const record = clone(doc);
    record._id = doc._id || crypto.randomUUID();
    if (this.docs.has(record._id)) {
      throw new Error(`Duplicate _id: ${record._id}`);
    }
    record.createdAt = record.createdAt || now;
    record.updatedAt = now;
    for (const [field, idx] of this.indexes) this._indexDoc(field, idx, record);
    this.docs.set(record._id, record);
    this._persist();
    return clone(record);
  }

  insertMany(docs) {
    return docs.map((d) => this.insert(d));
  }

  findById(id) {
    const doc = this.docs.get(id);
    return doc ? clone(doc) : null;
  }

  /**
   * Find documents matching a Mongo-style query.
   * Options: { sort: {field: 1|-1}, skip, limit, projection }
   */
  find(query = {}, options = {}) {
    // Fast path: unique/equality index lookup on a plain equality field
    let candidates = null;
    for (const [field, condition] of Object.entries(query)) {
      const idx = this.indexes.get(field);
      if (idx && !isPlainObject(condition) && !field.startsWith("$")) {
        const key = JSON.stringify(condition === undefined ? null : condition);
        const ids = idx.map.get(key);
        candidates = candidates === null ? new Set(ids || []) :
          new Set([...candidates].filter((id) => ids && ids.has(id)));
      }
    }

    let result = [];
    if (candidates !== null) {
      for (const id of candidates) {
        const doc = this.docs.get(id);
        if (doc && matchQuery(doc, query)) result.push(doc);
      }
      // Fall back to full scan for any residual operator conditions
      const hasOperators = Object.keys(query).some(
        (k) => k.startsWith("$") || isPlainObject(query[k])
      );
      if (hasOperators && result.length === 0 && candidates.size === 0) {
        result = [];
      }
    } else {
      for (const doc of this.docs.values()) {
        if (matchQuery(doc, query)) result.push(doc);
      }
    }

    result = applySort(result, options.sort);
    if (options.skip) result = result.slice(options.skip);
    if (options.limit !== undefined) result = result.slice(0, options.limit);
    return result.map((d) => applyProjection(clone(d), options.projection));
  }

  findOne(query = {}, options = {}) {
    const found = this.find(query, { ...options, limit: 1 });
    return found.length ? found[0] : null;
  }

  count(query = {}) {
    if (!query || Object.keys(query).length === 0) return this.docs.size;
    let n = 0;
    for (const doc of this.docs.values()) if (matchQuery(doc, query)) n++;
    return n;
  }

  /**
   * Update document(s). `target` is an _id string or a query object.
   * Returns { matched, modified }.
   */
  update(target, update, options = {}) {
    const multi = options.multi !== false; // default multi for query objects
    let ids = [];
    if (typeof target === "string") {
      if (this.docs.has(target)) ids = [target];
    } else {
      for (const doc of this.docs.values()) {
        if (matchQuery(doc, target)) {
          ids.push(doc._id);
          if (!multi) break;
        }
      }
    }

    let modified = 0;
    for (const id of ids) {
      const current = this.docs.get(id);
      for (const [field, idx] of this.indexes) this._unindexDoc(field, idx, current);
      const next = applyUpdate(current, update);
      next._id = current._id;
      next.createdAt = current.createdAt;
      next.updatedAt = new Date().toISOString();
      try {
        for (const [field, idx] of this.indexes) this._indexDoc(field, idx, next);
      } catch (err) {
        // rollback index entries
        for (const [field, idx] of this.indexes) this._indexDoc(field, idx, current);
        throw err;
      }
      this.docs.set(id, next);
      modified++;
    }
    if (modified) this._persist();
    return { matched: ids.length, modified };
  }

  /** Replace a whole document by _id (fields except _id are replaced). */
  replace(id, doc) {
    if (!this.docs.has(id)) return { matched: 0, modified: 0 };
    const current = this.docs.get(id);
    for (const [field, idx] of this.indexes) this._unindexDoc(field, idx, current);
    const next = clone(doc);
    next._id = id;
    next.createdAt = current.createdAt;
    next.updatedAt = new Date().toISOString();
    for (const [field, idx] of this.indexes) this._indexDoc(field, idx, next);
    this.docs.set(id, next);
    this._persist();
    return { matched: 1, modified: 1 };
  }

  /** Delete document(s). `target` is an _id string or a query object. */
  delete(target, options = {}) {
    const multi = options.multi !== false;
    let ids = [];
    if (typeof target === "string") {
      if (this.docs.has(target)) ids = [target];
    } else {
      for (const doc of this.docs.values()) {
        if (matchQuery(doc, target)) {
          ids.push(doc._id);
          if (!multi) break;
        }
      }
    }
    for (const id of ids) {
      const doc = this.docs.get(id);
      for (const [field, idx] of this.indexes) this._unindexDoc(field, idx, doc);
      this.docs.delete(id);
    }
    if (ids.length) this._persist();
    return { deleted: ids.length };
  }

  /** Remove all documents. */
  drop() {
    this.docs.clear();
    this._rebuildIndexes();
    this._persist();
    return true;
  }

  stats() {
    return {
      name: this.name,
      count: this.docs.size,
      indexes: [...this.indexes.keys()],
      file: this.file,
      sizeBytes: fs.existsSync(this.file) ? fs.statSync(this.file).size : 0,
    };
  }
}

/* -------------------------------- Database -------------------------------- */

class EquitasDB {
  /**
   * @param {string} dir Directory where collection files are stored.
   */
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.collections = new Map();
    this._queue = Promise.resolve(); // serialises writes
  }

  /** Get (and lazily create) a collection handle. */
  collection(name) {
    if (!this.collections.has(name)) {
      this.collections.set(name, new Collection(this, name));
    }
    return this.collections.get(name);
  }

  /** Atomic write-through persistence (temp file + rename). */
  _persistCollection(collection) {
    const payload = JSON.stringify(
      {
        engine: "EquitasDB/1",
        collection: collection.name,
        updatedAt: new Date().toISOString(),
        documents: [...collection.docs.values()],
      },
      null,
      2
    );
    // Serialise writes to avoid interleaved rename races.
    this._queue = this._queue.then(
      () =>
        new Promise((resolve, reject) => {
          const tmp = collection.file + ".tmp";
          fs.writeFile(tmp, payload, "utf8", (err) => {
            if (err) return reject(err);
            fs.rename(tmp, collection.file, (err2) =>
              err2 ? reject(err2) : resolve()
            );
          });
        })
    );
    return this._queue;
  }

  /** Wait until every queued write has hit the disk. */
  async flush() {
    await this._queue;
  }

  listCollections() {
    const names = new Set();
    for (const name of this.collections.keys()) names.add(name);
    if (fs.existsSync(this.dir)) {
      for (const file of fs.readdirSync(this.dir)) {
        if (file.endsWith(".json")) names.add(file.slice(0, -5));
      }
    }
    return [...names].sort();
  }

  stats() {
    return this.listCollections().map((name) => this.collection(name).stats());
  }

  /**
   * Seed from an in-memory map: { "collection-name": [doc, doc, ...] }.
   * Useful where the filesystem is read-only (e.g. serverless) and seed
   * documents are bundled via require().
   */
  seedObject(seedMap) {
    const seeded = [];
    for (const [name, docs] of Object.entries(seedMap || {})) {
      const col = this.collection(name);
      if (col.count() > 0) continue; // never overwrite live data
      if (Array.isArray(docs) && docs.length) {
        for (const doc of docs) {
          const now = new Date().toISOString();
          const record = clone(doc);
          record._id = record._id || crypto.randomUUID();
          record.createdAt = record.createdAt || now;
          record.updatedAt = record.updatedAt || now;
          col.docs.set(record._id, record);
        }
        col._persist();
      }
      seeded.push({ collection: name, count: docs.length || 0 });
    }
    return { seeded };
  }

  /** Load seed JSON files from a directory into empty collections. */
  seedFrom(seedDir) {
    if (!fs.existsSync(seedDir)) return { seeded: [] };
    const seeded = [];
    for (const file of fs.readdirSync(seedDir)) {
      if (!file.endsWith(".json")) continue;
      const name = file.slice(0, -5);
      const col = this.collection(name);
      if (col.count() > 0) continue; // never overwrite live data
      const docs = JSON.parse(fs.readFileSync(path.join(seedDir, file), "utf8"));
      if (Array.isArray(docs) && docs.length) {
        for (const doc of docs) {
          const now = new Date().toISOString();
          const record = clone(doc);
          record._id = record._id || crypto.randomUUID();
          record.createdAt = record.createdAt || now;
          record.updatedAt = record.updatedAt || now;
          col.docs.set(record._id, record);
        }
        col._persist();
      }
      seeded.push({ collection: name, count: docs.length || 0 });
    }
    return { seeded };
  }
}

module.exports = { EquitasDB, Collection, matchQuery, applyUpdate };
