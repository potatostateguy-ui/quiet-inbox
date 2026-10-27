'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { matchesTarget } = require('./util');

/**
 * One JSON file per scanned folder: { folderId, folderName, uidValidity, scannedAt, records: { id: record } }.
 * Kept in memory once loaded; written atomically.
 */
class Cache {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.mem = new Map();
  }

  _file(accountId, folderId) {
    const h = crypto.createHash('sha1').update(String(folderId)).digest('hex').slice(0, 16);
    return path.join(this.baseDir, accountId, `${h}.json`);
  }

  _key(accountId, folderId) {
    return `${accountId}\u0000${folderId}`;
  }

  load(accountId, folderId) {
    const k = this._key(accountId, folderId);
    if (this.mem.has(k)) return this.mem.get(k);
    try {
      const data = JSON.parse(fs.readFileSync(this._file(accountId, folderId), 'utf8'));
      this.mem.set(k, data);
      return data;
    } catch {
      return null;
    }
  }

  save(accountId, folderId, data) {
    this.mem.set(this._key(accountId, folderId), data);
    const file = this._file(accountId, folderId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  }

  /** Every cached folder for an account (loads them from disk if needed). */
  folders(accountId) {
    const dir = path.join(this.baseDir, accountId);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const out = [];
    for (const f of files) {
      try {
        const peek = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const data = this.load(accountId, peek.folderId) || peek;
        out.push(data);
      } catch {
        /* ignore corrupt file */
      }
    }
    return out;
  }

  removeIds(accountId, folderId, ids) {
    const data = this.load(accountId, folderId);
    if (!data) return;
    let changed = false;
    for (const id of ids) {
      if (data.records[id]) {
        delete data.records[id];
        changed = true;
      }
    }
    if (changed) this.save(accountId, folderId, data);
  }

  removeSender(accountId, value, mode) {
    for (const data of this.folders(accountId)) {
      let changed = false;
      for (const [id, r] of Object.entries(data.records)) {
        if (matchesTarget(r.f, value, mode)) {
          delete data.records[id];
          changed = true;
        }
      }
      if (changed) this.save(accountId, data.folderId, data);
    }
  }

  clearFolder(accountId, folderId) {
    this.mem.delete(this._key(accountId, folderId));
    fs.rmSync(this._file(accountId, folderId), { force: true });
  }

  clear(accountId) {
    for (const k of [...this.mem.keys()]) if (!accountId || k.startsWith(`${accountId}\u0000`)) this.mem.delete(k);
    const dir = accountId ? path.join(this.baseDir, accountId) : this.baseDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { Cache };
