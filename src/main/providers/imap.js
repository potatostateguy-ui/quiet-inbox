'use strict';

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const {
  chunk,
  compactRange,
  normAddr,
  matchesTarget,
  parseUnsubscribe,
  parseAuthResults,
  sanitizeEmailHtml,
  sortFolderTree,
  headerValue,
  UserError,
} = require('../util');
const { toRecord } = require('../analytics');

const SPECIAL_MAP = {
  '\\Inbox': 'inbox',
  '\\Junk': 'junk',
  '\\Trash': 'trash',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\All': 'all',
  '\\Archive': 'archive',
  '\\Flagged': 'flagged',
};

const FALLBACK_NAMES = {
  trash: ['trash', 'deleted items', 'deleted messages', 'deleted', 'bin'],
  junk: ['junk', 'spam', 'junk e-mail', 'junk email', 'bulk mail', 'bulk'],
};

function hasAttachment(node) {
  if (!node) return false;
  if (node.childNodes) return node.childNodes.some(hasAttachment);
  const disp = String(node.disposition || '').toLowerCase();
  if (disp === 'attachment') return true;
  const type = String(node.type || '').toLowerCase();
  const named = node.dispositionParameters?.filename || node.parameters?.name;
  return disp !== 'inline' && !!named && !type.startsWith('text/') && !type.startsWith('multipart/');
}

function toIso(d) {
  if (!d) return null;
  const t = new Date(d);
  return isNaN(t) ? null : t.toISOString();
}

function addrList(v) {
  const arr = Array.isArray(v) ? v : v ? [v] : [];
  return arr.flatMap((a) => a.value || []).map((a) => ({ name: a.name || '', address: normAddr(a.address) }));
}

function rawHeaderBlock(source) {
  let end = source.indexOf('\r\n\r\n');
  if (end < 0) end = source.indexOf('\n\n');
  return source.slice(0, end < 0 ? Math.min(source.length, 64 * 1024) : end).toString('utf8');
}

function friendlyImapError(e, imap) {
  if (e.userFacing) return e;
  const where = `${imap.host}:${imap.port}`;
  if (e.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(e.responseText || e.message)) {
    return new UserError(
      'The password was not accepted. For Gmail, Yahoo, AOL and iCloud this must be an app password, not your normal password. Check it was copied completely.'
    );
  }
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(e.code)) return new UserError(`Couldn't find the server ${imap.host}. Check the host name.`);
  if (['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'].includes(e.code) || /timeout/i.test(e.message)) {
    return new UserError(`Couldn't connect to ${where}. Check the port and security setting, or a firewall.`);
  }
  if (/certificate|self[- ]signed|CERT_/i.test(e.message)) {
    return new UserError(`The certificate for ${imap.host} isn't trusted. If this is your own server, turn on “Allow untrusted certificate”.`);
  }
  return new UserError(`${imap.host}: ${e.responseText || e.message}`);
}

class ImapProvider {
  /**
   * @param {object} account  { id, email, kind, imap: { host, port, security, user, allowInvalidCert } }
   * @param {object} deps     { getAuth: async () => ({ user, pass } | { user, accessToken }) }
   */
  constructor(account, { getAuth }) {
    this.account = account;
    this.getAuth = getAuth;
    const host = account.imap?.host || '';
    this.isGmail = /(^|\.)(gmail|googlemail)\.com$/i.test(host);
    this.client = null;
    this.connecting = null;
    this.clientExpires = 0;
    this.folders = null;
    this.uidCache = new Map();
  }

  _options(auth) {
    const im = this.account.imap;
    const security = im.security || (Number(im.port) === 993 ? 'tls' : 'starttls');
    return {
      host: im.host,
      port: Number(im.port),
      secure: security === 'tls',
      doSTARTTLS: security === 'starttls' ? true : security === 'none' ? false : undefined,
      auth,
      logger: false,
      clientInfo: { name: 'Quiet Inbox', version: '1.0.0' },
      disableAutoIdle: true,
      tls: { rejectUnauthorized: !im.allowInvalidCert },
      connectionTimeout: 30000,
      greetingTimeout: 20000,
      socketTimeout: 5 * 60 * 1000,
    };
  }

  async _connect() {
    const auth = await this.getAuth();
    const c = new ImapFlow(this._options(auth));
    c.on('error', () => {}); // surfaced through usable/close + rejected commands
    try {
      await c.connect();
    } catch (e) {
      if (this.account.kind === 'microsoft' && (e.authenticationFailed || /AUTHENTICATE failed|AUTHENTICATIONFAILED/i.test(e.responseText || e.message))) {
        throw new UserError('Microsoft wants you to sign in again. Open Settings and choose “Sign in again” next to this email.');
      }
      throw friendlyImapError(e, this.account.imap);
    }
    return c;
  }

  async _client() {
    if (this.client && this.client.usable && Date.now() < this.clientExpires) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        const old = this.client;
        this.client = null;
        if (old) setTimeout(() => old.logout().catch(() => {}), 30000);
        const c = await this._connect();
        c.on('close', () => {
          if (this.client === c) this.client = null;
        });
        this.client = c;
        // Reconnect periodically; long idle IMAP sessions get dropped by most providers anyway.
        this.clientExpires = Date.now() + 40 * 60 * 1000;
        return c;
      })().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  async _withMailbox(path, fn, { dedicated = false, readOnly = false } = {}) {
    const run = async (c) => {
      const lock = await c.getMailboxLock(path, { readOnly });
      try {
        return await fn(c, c.mailbox);
      } finally {
        lock.release();
      }
    };
    if (dedicated) {
      const c = await this._connect();
      try {
        return await run(c);
      } finally {
        c.logout().catch(() => {});
      }
    }
    const c = await this._client();
    try {
      return await run(c);
    } catch (e) {
      if (!c.usable || e.code === 'NoConnection') return run(await this._client());
      throw e;
    }
  }

  async testConnection() {
    const c = await this._connect();
    const caps = [...(c.capabilities?.keys?.() || [])];
    await c.logout().catch(() => {});
    return { ok: true, capabilities: caps };
  }

  async close() {
    const c = this.client;
    this.client = null;
    if (c) await c.logout().catch(() => {});
  }

  // ---------- folders ----------

  async listFolders() {
    const c = await this._client();
    let list;
    try {
      list = await c.list({ statusQuery: { messages: true, unseen: true } });
    } catch {
      list = await c.list();
    }
    const folders = list.map((f) => {
      const isInbox = f.path.toUpperCase() === 'INBOX';
      let special = SPECIAL_MAP[f.specialUse] || (isInbox ? 'inbox' : null);
      if (!special) {
        const n = f.name.toLowerCase();
        for (const [kind, names] of Object.entries(FALLBACK_NAMES)) if (names.includes(n) && f.parent.length === 0) special = kind;
      }
      return {
        id: f.path,
        parentId: f.parentPath || null,
        name: isInbox ? 'Inbox' : f.name,
        special,
        selectable: !f.flags.has('\\Noselect') && !f.flags.has('\\NonExistent'),
        total: f.status?.messages ?? null,
        unread: f.status?.unseen ?? null,
      };
    });
    this.folders = sortFolderTree(folders);
    return this.folders;
  }

  async _specialPath(kind) {
    if (!this.folders) await this.listFolders();
    const f = this.folders.find((x) => x.special === kind && x.selectable);
    return f ? f.id : null;
  }

  // ---------- message list ----------

  _summary(m, folderId) {
    const from = m.envelope?.from?.[0] || {};
    const hdr = m.headers ? m.headers.toString('utf8') : '';
    return {
      id: String(m.uid),
      folderId,
      from: { name: from.name || '', address: normAddr(from.address) },
      subject: m.envelope?.subject || '',
      date: toIso(m.internalDate) || toIso(m.envelope?.date),
      size: m.size || 0,
      seen: m.flags ? m.flags.has('\\Seen') : false,
      flagged: m.flags ? m.flags.has('\\Flagged') : false,
      hasAttachments: m.bodyStructure ? hasAttachment(m.bodyStructure) : /multipart\/mixed/i.test(hdr),
      unsubscribe: /^list-unsubscribe:/im.test(hdr),
    };
  }

  async listMessages(folderId, { cursor = null, query = '', pageSize = 60 } = {}) {
    return this._withMailbox(folderId, async (c, mb) => {
      const q = String(query || '').trim();
      let uids;
      if (q) {
        uids = this.isGmail
          ? await c.search({ gmraw: q }, { uid: true })
          : await c.search({ or: [{ from: q }, { subject: q }, { to: q }] }, { uid: true });
      } else {
        const key = `${mb.uidValidity}|${mb.exists}|${mb.uidNext}`;
        const cached = this.uidCache.get(folderId);
        if (cached && cached.key === key) uids = cached.uids;
        else {
          uids = mb.exists ? await c.search({ all: true }, { uid: true }) : [];
          this.uidCache.set(folderId, { key, uids: uids || [] });
        }
      }
      let ordered = (uids || []).slice().sort((a, b) => b - a);
      const total = ordered.length;
      if (cursor) ordered = ordered.filter((u) => u < Number(cursor));
      const page = ordered.slice(0, pageSize);
      const items = [];
      if (page.length) {
        const query = { uid: true, envelope: true, flags: true, size: true, internalDate: true, bodyStructure: true, headers: ['list-unsubscribe'] };
        for await (const m of c.fetch(compactRange(page), query, { uid: true })) items.push(this._summary(m, folderId));
      }
      items.sort((a, b) => Number(b.id) - Number(a.id));
      return { items, total, nextCursor: ordered.length > pageSize ? String(page[page.length - 1]) : null };
    });
  }

  async getMessage(folderId, id, { markRead = false } = {}) {
    return this._withMailbox(folderId, async (c) => {
      const m = await c.fetchOne(String(id), { uid: true, source: true, flags: true, size: true, internalDate: true }, { uid: true });
      if (!m || !m.source) throw new UserError('That message is no longer on the server. Refresh the folder.');
      // mailparser inlines cid: images as data: URIs by default.
      const parsed = await simpleParser(m.source);
      const headers = rawHeaderBlock(m.source);
      if (markRead && !m.flags?.has('\\Seen')) await c.messageFlagsAdd(String(id), ['\\Seen'], { uid: true }).catch(() => {});
      const html = parsed.html || parsed.textAsHtml || '';
      return {
        id: String(id),
        folderId,
        subject: parsed.subject || '',
        from: addrList(parsed.from)[0] || { name: '', address: '' },
        to: addrList(parsed.to),
        cc: addrList(parsed.cc),
        date: toIso(m.internalDate) || toIso(parsed.date),
        size: m.size || 0,
        html: sanitizeEmailHtml(html),
        attachments: (parsed.attachments || [])
          .filter((a) => !(a.related && a.cid))
          .map((a) => ({ name: a.filename || 'attachment', size: a.size || 0, type: a.contentType })),
        headers,
        auth: parseAuthResults(headers),
        unsubscribe: parseUnsubscribe(headerValue(headers, 'list-unsubscribe'), headerValue(headers, 'list-unsubscribe-post')),
      };
    });
  }

  async getUnsubscribe(folderId, id) {
    return this._withMailbox(folderId, async (c) => {
      const m = await c.fetchOne(String(id), { uid: true, headers: ['list-unsubscribe', 'list-unsubscribe-post'] }, { uid: true });
      const h = m?.headers ? m.headers.toString('utf8') : '';
      return parseUnsubscribe(headerValue(h, 'list-unsubscribe'), headerValue(h, 'list-unsubscribe-post'));
    });
  }

  // ---------- actions ----------

  async trash(folderId, ids) {
    if (!ids.length) return { count: 0 };
    const trashPath = await this._specialPath('trash');
    if (!trashPath) throw new UserError('This account has no Trash folder. Use “Delete forever” instead.');
    if (folderId === trashPath) return this.destroy(folderId, ids);
    return this._withMailbox(folderId, async (c) => {
      const r = await c.messageMove(compactRange(ids), trashPath, { uid: true });
      this.uidCache.delete(folderId);
      this.uidCache.delete(trashPath);
      const moved = r && r.uidMap ? [...r.uidMap.values()] : [];
      return { count: r ? (r.uidMap ? r.uidMap.size : ids.length) : 0, undo: moved.length ? [{ from: folderId, uids: moved }] : [] };
    });
  }

  /** Moves messages back out of Trash using the UIDs the server reported when they were moved in. */
  async restore(undo) {
    const trashPath = await this._specialPath('trash');
    let count = 0;
    for (const u of undo || []) {
      if (!u.uids?.length) continue;
      const folder = (this.folders || []).find((f) => f.id === u.from);
      // Gmail: putting mail back into All Mail would archive it, so bring it back to the Inbox instead.
      const dest = this.isGmail && folder?.special === 'all' ? 'INBOX' : u.from;
      await this._withMailbox(trashPath, async (c) => {
        const r = await c.messageMove(compactRange(u.uids), dest, { uid: true });
        count += r ? (r.uidMap ? r.uidMap.size : u.uids.length) : 0;
      });
      this.uidCache.delete(dest);
    }
    this.uidCache.delete(trashPath);
    return { count };
  }

  /** Permanently removes everything in a folder (used for Trash and Spam). */
  async emptyFolder(folderId) {
    return this._withMailbox(folderId, async (c, mb) => {
      if (!mb.exists) return { count: 0, bytes: 0 };
      let bytes = 0;
      let count = 0;
      for await (const m of c.fetch('1:*', { uid: true, size: true })) {
        bytes += m.size || 0;
        count++;
      }
      await c.messageDelete('1:*');
      this.uidCache.delete(folderId);
      return { count, bytes };
    });
  }

  async destroy(folderId, ids) {
    if (!ids.length) return { count: 0, bytes: 0 };
    const trashPath = this.isGmail ? await this._specialPath('trash') : null;

    if (this.isGmail && trashPath && folderId !== trashPath) {
      // In Gmail, expunging from Inbox or a label only removes the label. Space is freed
      // only when the message is expunged from Trash, so move it there first.
      const moved = await this._withMailbox(folderId, async (c) => {
        const meta = [];
        for await (const m of c.fetch(compactRange(ids), { uid: true, size: true, emailId: true }, { uid: true })) meta.push(m);
        const r = meta.length ? await c.messageMove(compactRange(meta.map((m) => m.uid)), trashPath, { uid: true }) : null;
        this.uidCache.delete(folderId);
        return {
          bytes: meta.reduce((s, m) => s + (m.size || 0), 0),
          trashUids: r && r.uidMap ? [...r.uidMap.values()] : [],
          emailIds: meta.map((m) => m.emailId).filter(Boolean),
        };
      });
      return this._withMailbox(trashPath, async (c) => {
        const uids = moved.trashUids.slice();
        if (!uids.length) {
          for (const emailId of moved.emailIds) {
            const r = await c.search({ emailId }, { uid: true });
            if (r) uids.push(...r);
          }
        }
        if (uids.length) await c.messageDelete(compactRange(uids), { uid: true });
        this.uidCache.delete(trashPath);
        return { count: uids.length, bytes: moved.bytes };
      });
    }

    return this._withMailbox(folderId, async (c) => {
      let bytes = 0;
      const found = [];
      for await (const m of c.fetch(compactRange(ids), { uid: true, size: true }, { uid: true })) {
        bytes += m.size || 0;
        found.push(m.uid);
      }
      if (found.length) await c.messageDelete(compactRange(found), { uid: true });
      this.uidCache.delete(folderId);
      return { count: found.length, bytes };
    });
  }

  async markRead(folderId, ids, read = true) {
    return this._withMailbox(folderId, async (c) => {
      if (read) await c.messageFlagsAdd(compactRange(ids), ['\\Seen'], { uid: true });
      else await c.messageFlagsRemove(compactRange(ids), ['\\Seen'], { uid: true });
      return { count: ids.length };
    });
  }

  /** Star (Gmail, Yahoo) / flag (Outlook) — the standard IMAP \\Flagged marker. */
  async flag(folderId, ids, on = true) {
    return this._withMailbox(folderId, async (c) => {
      if (on) await c.messageFlagsAdd(compactRange(ids), ['\\Flagged'], { uid: true });
      else await c.messageFlagsRemove(compactRange(ids), ['\\Flagged'], { uid: true });
      return { count: ids.length };
    });
  }

  /** Every UID in a folder except starred ones (bulk actions never touch starred mail). */
  async unstarredUids(folderId) {
    return this._withMailbox(folderId, async (c, mb) => (mb.exists ? (await c.search({ flagged: false }, { uid: true })) || [] : []));
  }

  async trashAll(folderId) {
    const uids = await this.unstarredUids(folderId);
    let count = 0;
    const undo = [];
    for (const part of chunk(uids, 2000)) {
      const r = await this.trash(folderId, part);
      count += r.count;
      if (r.undo) undo.push(...r.undo);
    }
    return { count, undo };
  }

  async destroyAll(folderId) {
    const uids = await this.unstarredUids(folderId);
    let count = 0;
    let bytes = 0;
    for (const part of chunk(uids, 2000)) {
      const r = await this.destroy(folderId, part);
      count += r.count;
      bytes += r.bytes || 0;
    }
    return { count, bytes };
  }

  async junk(folderId, ids) {
    const junkPath = await this._specialPath('junk');
    if (!junkPath) throw new UserError('This account has no Junk or Spam folder.');
    if (junkPath === folderId) return { count: 0 };
    return this._withMailbox(folderId, async (c) => {
      const r = await c.messageMove(compactRange(ids), junkPath, { uid: true });
      this.uidCache.delete(folderId);
      return { count: r ? ids.length : 0 };
    });
  }

  // ---------- sender-wide work ----------

  async _senderFolders(specials) {
    if (!this.folders) await this.listFolders();
    const sel = this.folders.filter((f) => f.selectable);
    if (specials) return sel.filter((f) => specials.includes(f.special));
    if (this.isGmail) {
      // In Gmail every message lives in All Mail; Inbox and labels are views of it.
      const pick = sel.filter((f) => ['all', 'junk', 'trash'].includes(f.special));
      if (pick.some((f) => f.special === 'all')) return pick;
    }
    return sel.filter((f) => !['sent', 'drafts', 'all', 'flagged'].includes(f.special));
  }

  /**
   * targets: [{ value, mode: 'sender'|'domain' }]
   * Returns [{ folderId, folderName, special, ids, count, bytes }] for messages matching any target.
   */
  async findMatching(targets, { specials = null, onProgress } = {}) {
    const clean = targets.map((t) => ({ value: normAddr(t.value).replace(/^@/, ''), mode: t.mode || 'sender' })).filter((t) => t.value);
    if (!clean.length) return [];
    const folders = await this._senderFolders(specials);
    const criteria = clean.length === 1 ? { from: clean[0].value } : { or: clean.map((t) => ({ from: t.value })) };
    const results = [];
    const c = await this._connect();
    try {
      for (const f of folders) {
        onProgress?.(`Searching ${f.name}`);
        const lock = await c.getMailboxLock(f.id, { readOnly: true });
        try {
          if (!c.mailbox.exists) continue;
          const hits = (await c.search(criteria, { uid: true })) || [];
          if (!hits.length) continue;
          const ids = [];
          let bytes = 0;
          // IMAP FROM search is a substring match, so confirm the exact address or domain.
          for (const part of chunk(hits, 2000)) {
            for await (const m of c.fetch(compactRange(part), { uid: true, envelope: true, size: true, flags: true }, { uid: true })) {
              const addr = m.envelope?.from?.[0]?.address;
              if (m.flags?.has('\\Flagged')) continue; // starred = keep
              if (clean.some((t) => matchesTarget(addr, t.value, t.mode))) {
                ids.push(m.uid);
                bytes += m.size || 0;
              }
            }
          }
          if (ids.length) results.push({ folderId: f.id, folderName: f.name, special: f.special, ids, count: ids.length, bytes });
        } finally {
          lock.release();
        }
      }
    } finally {
      c.logout().catch(() => {});
    }
    return results;
  }

  findFromSender(target, mode = 'sender', opts = {}) {
    return this.findMatching([{ value: target, mode }], opts);
  }

  async purgeFound(found, permanent, { onProgress } = {}) {
    const trashPath = await this._specialPath('trash');
    let count = 0;
    let bytes = 0;
    const undo = [];
    // Trash last, so Gmail's move-then-expunge never touches messages we are about to expunge anyway.
    const ordered = found.slice().sort((a, b) => (a.folderId === trashPath) - (b.folderId === trashPath));
    for (const f of ordered) {
      onProgress?.(`${permanent ? 'Deleting' : 'Trashing'} ${f.count} in ${f.folderName}`);
      for (const ids of chunk(f.ids, 1000)) {
        if (permanent) {
          const r = await this.destroy(f.folderId, ids);
          count += r.count;
          bytes += r.bytes || 0;
        } else if (f.folderId !== trashPath) {
          const r = await this.trash(f.folderId, ids);
          count += r.count;
          if (r.undo) undo.push(...r.undo);
        }
      }
      if (!permanent && f.folderId !== trashPath) bytes += f.bytes;
    }
    return { count, bytes, undo };
  }

  // ---------- analytics ----------

  async scanFolder(folderId, prev, onProgress) {
    return this._withMailbox(
      folderId,
      async (c, mb) => {
        const uidValidity = String(mb.uidValidity);
        const records = prev && prev.uidValidity === uidValidity && prev.records ? prev.records : {};
        const current = mb.exists ? (await c.search({ all: true }, { uid: true })) || [] : [];
        const live = new Set(current.map(String));
        for (const k of Object.keys(records)) if (!live.has(k)) delete records[k];
        const missing = current.filter((u) => !records[u]);
        const known = current.length - missing.length;
        let done = 0;
        onProgress?.({ done: known, total: current.length });
        const query = { uid: true, envelope: true, flags: true, size: true, internalDate: true, headers: ['list-unsubscribe', 'content-type'] };
        for (const part of chunk(missing, 1500)) {
          for await (const m of c.fetch(compactRange(part), query, { uid: true })) {
            const s = this._summary(m, folderId);
            records[s.id] = toRecord(s);
            done++;
            if (done % 250 === 0) onProgress?.({ done: known + done, total: current.length });
          }
        }
        if (known > 0) {
          // Refresh read/unread state for messages we already had.
          for await (const m of c.fetch('1:*', { uid: true, flags: true })) {
            const r = records[m.uid];
            if (r) {
              r.r = m.flags.has('\\Seen') ? 1 : 0;
              r.p = m.flags.has('\\Flagged') ? 1 : 0;
            }
          }
        }
        onProgress?.({ done: current.length, total: current.length });
        return { uidValidity, records };
      },
      { dedicated: true, readOnly: true }
    );
  }
}

module.exports = { ImapProvider, hasAttachment };
