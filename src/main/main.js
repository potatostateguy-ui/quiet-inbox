'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage, nativeTheme, Menu, Tray, nativeImage } = require('electron');
const path = require('path');
const crypto = require('crypto');

const { Store } = require('./store');
const { Cache } = require('./cache');
const analytics = require('./analytics');
const { PRESETS } = require('./presets');
const { discover } = require('./discovery');
const oauth = require('./oauth');
const { openSignInWindow, cancelSignInWindow } = require('./signin-window');
const fs = require('fs');
const { ImapProvider } = require('./providers/imap');
const { UserError, normAddr } = require('./util');

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let store = null;
let cache = null;
let ruleTimer = null;
let rulesRunning = null;
let tray = null;
let quitting = false;
let lastRulesText = 'Hasn’t checked blocked senders yet';
const startHidden = process.argv.includes('--hidden');
const ICON = path.join(__dirname, '..', '..', 'build', 'icon.png');
const providers = new Map();
const tokens = new Map();
const refreshing = new Map();
let oauthConfig = {};
const previews = new Map();
const multiPreviews = new Map(); // token -> { targets, found: [{ accountId, found }], at }
const undoStack = new Map(); // accountId -> { entries, at }

const THEME = { light: { bg: '#F2F4F2', symbol: '#16201B' }, dark: { bg: '#0F1412', symbol: '#E3EAE6' } };
const ZOOM = { normal: 1, large: 1.15, larger: 1.3 };

const secretBox = {
  seal(s) {
    if (s == null) return null;
    if (safeStorage.isEncryptionAvailable()) return `enc:${safeStorage.encryptString(String(s)).toString('base64')}`;
    return `b64:${Buffer.from(String(s)).toString('base64')}`;
  },
  unseal(v) {
    if (!v) return null;
    if (v.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
    if (v.startsWith('b64:')) return Buffer.from(v.slice(4), 'base64').toString('utf8');
    return v;
  },
};

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
function progress(text, extra = {}) {
  send('progress', { text, ...extra, ts: Date.now() });
}

function loadOAuthConfig() {
  for (const p of [path.join(app.getAppPath(), 'oauth.config.json'), path.join(path.dirname(app.getPath('exe')), 'oauth.config.json')]) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      /* not here */
    }
  }
  return {};
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MS_BASE = process.env.QUIET_INBOX_MS_BASE || undefined; // tests only
/** Client ID from Settings (added any time, no rebuild) or else the one built in from oauth.config.json. */
function msClientId() {
  return store.settings.microsoftClientId || oauthConfig.microsoftClientId || '';
}

/** Fresh Microsoft access token for an account; refresh tokens are rotated and re-saved. */
async function getAccessToken(account) {
  const t = tokens.get(account.id);
  if (t && t.expiresAt > Date.now() + 2 * 60 * 1000) return t.accessToken;
  if (refreshing.has(account.id)) return refreshing.get(account.id);
  const job = (async () => {
    const old = store.unseal(account.secret);
    let fresh;
    try {
      fresh = await oauth.refresh({ clientId: msClientId(), tenant: account.tenant || 'consumers', refreshToken: old, base: MS_BASE });
    } catch {
      throw new UserError('Microsoft wants you to sign in again. Open Settings and choose “Sign in again” next to this email.');
    }
    tokens.set(account.id, fresh);
    if (fresh.refreshToken !== old) {
      account.secret = store.seal(fresh.refreshToken);
      store.saveAccounts();
    }
    return fresh.accessToken;
  })().finally(() => refreshing.delete(account.id));
  refreshing.set(account.id, job);
  return job;
}

function buildProvider(account, password) {
  if (account.kind === 'microsoft') {
    return new ImapProvider(account, { getAuth: async () => ({ user: account.imap.user || account.email, accessToken: await getAccessToken(account) }) });
  }
  return new ImapProvider(account, { getAuth: async () => ({ user: account.imap.user || account.email, pass: password ?? store.unseal(account.secret) }) });
}

async function microsoftSignIn({ email, tenant, existing, method = 'window' }) {
  progress(method === 'browser' ? 'Waiting for you to sign in on the Microsoft page in your browser' : 'Waiting for you to sign in to Microsoft', { busy: true });
  const t =
    method === 'browser'
      ? await oauth.authorize({ clientId: msClientId(), tenant, loginHint: email, openExternal: (u) => shell.openExternal(u), base: MS_BASE })
      : await oauth.authorizeInWindow({ clientId: msClientId(), tenant, loginHint: email, base: MS_BASE, openWindow: (url, redirect) => openSignInWindow(url, redirect, { parent: win }) });
  const signedIn = t.email || normAddr(email);
  const account = existing || { id: crypto.randomUUID(), kind: 'microsoft', service: 'outlook' };
  Object.assign(account, {
    email: signedIn,
    name: t.name,
    tenant,
    imap: { host: 'outlook.office365.com', port: 993, security: 'tls', user: signedIn },
    secret: store.seal(t.refreshToken),
  });
  tokens.set(account.id, t);
  progress('Connecting to your mailbox', { busy: true });
  const test = buildProvider(account);
  try {
    await test.testConnection();
  } catch (e) {
    tokens.delete(account.id);
    throw new UserError(`Signed in, but the mailbox didn’t open: ${e.message}`);
  }
  store.upsertAccount(account);
  const old = providers.get(account.id);
  if (old) old.close().catch(() => {});
  providers.delete(account.id);
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  progress(`Connected ${signedIn}`);
  return { account: publicAccount(account), differs: !!email && normAddr(email) !== signedIn };
}

function provider(accountId) {
  if (providers.has(accountId)) return providers.get(accountId);
  const account = store.getAccount(accountId);
  if (!account) throw new UserError('That email account has been removed.');
  const p = buildProvider(account);
  providers.set(accountId, p);
  return p;
}

function publicAccount(a) {
  return { id: a.id, email: a.email, name: a.name || '', kind: a.kind || 'imap', service: a.service || 'other', host: a.imap.host, isGmail: provider(a.id).isGmail };
}
const label = (id) => store.getAccount(id)?.email || id;
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;

function remember(accountId, entries, { append = false } = {}) {
  if (!entries || !entries.length) return false;
  const prev = append ? undoStack.get(accountId) : null;
  undoStack.set(accountId, { entries: prev ? prev.entries.concat(entries) : entries, at: Date.now() });
  return true;
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      if (!e.userFacing) console.error(`[${channel}]`, e);
      return { ok: false, error: e.userFacing ? e.message : e.responseText || e.message || String(e) };
    }
  });
}

function applyZoom() {
  if (win) win.webContents.setZoomFactor(ZOOM[store.settings.textSize] || 1);
}

function registerIpc() {
  handle('settings:get', () => store.publicSettings());
  handle('settings:set', (patch = {}) => {
    if ('microsoftClientId' in patch) {
      patch.microsoftClientId = String(patch.microsoftClientId || '').trim();
      if (patch.microsoftClientId && !GUID.test(patch.microsoftClientId)) throw new UserError('That doesn’t look like a client ID. It looks like 1a2b3c4d-1111-2222-3333-444455556666.');
      tokens.clear();
    }
    const s = store.updateSettings(patch);
    if ('theme' in patch) nativeTheme.themeSource = s.theme;
    if ('textSize' in patch) applyZoom();
    if ('ruleIntervalMin' in patch) scheduleRules();
    if ('startWithWindows' in patch) applyStartup();
    if ('startWithWindows' in patch || 'runInBackground' in patch) updateTrayMenu();
    return s;
  });
  handle('app:info', () => ({ version: app.getVersion(), dataDir: app.getPath('userData'), encrypted: safeStorage.isEncryptionAvailable() }));
  handle('app:theme', (resolved) => {
    const t = THEME[resolved] || THEME.light;
    try {
      win?.setTitleBarOverlay({ color: t.bg, symbolColor: t.symbol, height: 44 });
    } catch {
      /* not supported */
    }
    return true;
  });
  handle('app:openLink', (url) => confirmAndOpen(url));
  // Help pages come from our own presets, so they open without a confirmation step.
  handle('app:openHelp', (key) => {
    const url = PRESETS[key]?.helpUrl;
    if (url) shell.openExternal(url);
    return !!url;
  });
  handle('app:openDataFolder', () => shell.openPath(app.getPath('userData')));

  // accounts
  handle('accounts:list', () => store.accounts.map(publicAccount));
  handle('accounts:discover', async (email) => {
    const found = await discover(normAddr(email));
    if (found?.oauth === 'microsoft') found.available = !!msClientId();
    return found;
  });
  handle('accounts:addMicrosoft', ({ email, tenant, method }) => microsoftSignIn({ email, tenant: tenant || 'consumers', method }));
  handle('app:msStatus', () => ({ clientId: msClientId(), source: store.settings.microsoftClientId ? 'settings' : oauthConfig.microsoftClientId ? 'built-in' : null, builtIn: oauthConfig.microsoftClientId || '' }));
  handle('accounts:reauth', (id, method) => {
    const a = store.getAccount(id);
    if (!a || a.kind !== 'microsoft') throw new UserError('Only Microsoft accounts sign in this way.');
    return microsoftSignIn({ email: a.email, tenant: a.tenant || 'consumers', existing: a, method });
  });
  handle('accounts:cancelSignIn', () => {
    oauth.cancelPending();
    cancelSignInWindow();
    return true;
  });
  handle('accounts:add', async (cfg) => {
    const email = normAddr(cfg.email);
    const preset = PRESETS[cfg.preset] || PRESETS.other;
    if (preset.oauth) throw new UserError('Microsoft addresses use “Sign in with Microsoft” instead of a password.');
    let password = String(cfg.password || '');
    if (preset.squash) password = password.replace(/\s+/g, '');
    else password = password.trim();
    if (!email.includes('@')) throw new UserError('Type your full email address, like name@example.com.');
    if (!cfg.host) throw new UserError('The mail server is missing. Open “Server settings” and type it in.');
    if (!password) throw new UserError('Paste the password first.');
    const account = {
      id: crypto.randomUUID(),
      service: cfg.preset || 'other',
      email,
      imap: { host: String(cfg.host).trim(), port: Number(cfg.port) || 993, security: cfg.security || 'tls', user: (cfg.user || '').trim() || email, allowInvalidCert: !!cfg.allowInvalidCert },
      secret: store.seal(password),
    };
    progress(`Connecting to ${preset.label === 'your email provider' ? account.imap.host : preset.label}`, { busy: true });
    await buildProvider(account, password).testConnection();
    store.upsertAccount(account);
    providers.delete(account.id);
    progress(`Connected ${email}`);
    return publicAccount(account);
  });
  handle('accounts:remove', async (id) => {
    const p = providers.get(id);
    if (p) await p.close().catch(() => {});
    providers.delete(id);
    tokens.delete(id);
    undoStack.delete(id);
    cache.clear(id);
    store.removeAccount(id);
    return true;
  });

  // mail
  handle('mail:folders', (id) => provider(id).listFolders());
  handle('mail:list', (id, folderId, opts) => provider(id).listMessages(folderId, opts || {}));
  handle('mail:get', (id, folderId, msgId) => provider(id).getMessage(folderId, msgId, { markRead: store.settings.markReadOnOpen }));
  handle('mail:markRead', (id, folderId, ids, read) => provider(id).markRead(folderId, ids, read));
  handle('mail:trash', async (id, folderId, ids, bytes = 0) => {
    const r = await provider(id).trash(folderId, ids);
    cache.removeIds(id, folderId, ids);
    const permanent = r.bytes != null; // trashing inside Trash deletes for good
    store.logActivity({ accountId: id, email: label(id), action: permanent ? 'delete' : 'trash', target: plural(r.count, 'email'), count: r.count, bytes: permanent ? r.bytes : bytes, permanent });
    return { count: r.count, bytes: r.bytes, undoable: remember(id, r.undo) };
  });
  handle('mail:destroy', async (id, folderId, ids, bytes = 0) => {
    const r = await provider(id).destroy(folderId, ids);
    const freed = r.bytes || bytes;
    cache.removeIds(id, folderId, ids);
    store.logActivity({ accountId: id, email: label(id), action: 'delete', target: plural(r.count, 'email'), count: r.count, bytes: freed, permanent: true });
    return { ...r, bytes: freed };
  });
  handle('mail:junk', async (id, folderId, ids) => {
    const r = await provider(id).junk(folderId, ids);
    cache.removeIds(id, folderId, ids);
    store.logActivity({ accountId: id, email: label(id), action: 'junk', target: plural(r.count, 'email'), count: r.count, bytes: 0 });
    return r;
  });
  handle('mail:flag', (id, folderId, ids, on) => provider(id).flag(folderId, ids, on));
  handle('mail:folderAction', async (id, folderId, name, action) => {
    progress(`${action === 'destroy' ? 'Deleting' : 'Moving'} every email in ${name}`, { busy: true });
    const p = provider(id);
    const r = action === 'destroy' ? await p.destroyAll(folderId) : await p.trashAll(folderId);
    cache.clearFolder(id, folderId);
    const permanent = action === 'destroy';
    store.logActivity({ accountId: id, email: label(id), action: permanent ? 'delete' : 'trash', target: `${plural(r.count, 'email')} in ${name}`, count: r.count, bytes: r.bytes || 0, permanent });
    return { count: r.count, bytes: r.bytes, undoable: permanent ? false : remember(id, r.undo) };
  });
  handle('mail:emptyFolder', async (id, folderId, name) => {
    progress(`Emptying ${name}`, { busy: true });
    const r = await provider(id).emptyFolder(folderId);
    cache.clearFolder(id, folderId);
    undoStack.delete(id);
    store.logActivity({ accountId: id, email: label(id), action: 'empty', target: name, count: r.count, bytes: r.bytes, permanent: true });
    return r;
  });
  handle('mail:undo', async (id) => {
    const u = undoStack.get(id);
    if (!u) throw new UserError('There’s nothing to undo.');
    undoStack.delete(id);
    const r = await provider(id).restore(u.entries);
    store.logActivity({ accountId: id, email: label(id), action: 'undo', target: plural(r.count, 'email'), count: r.count, bytes: 0 });
    return r;
  });

  // sender / domain wide
  handle('sender:preview', async (id, value, mode = 'sender') => {
    const target = normAddr(value).replace(/^@/, '');
    progress(`Looking through every folder for ${mode === 'domain' ? target : target}`, { busy: true });
    const found = await provider(id).findFromSender(target, mode, { onProgress: (t) => progress(t, { busy: true }) });
    previews.set(`${id}|${mode}|${target}`, { found, at: Date.now() });
    const count = found.reduce((s, f) => s + f.count, 0);
    progress(`Found ${plural(count, 'email')}`);
    return { count, bytes: found.reduce((s, f) => s + f.bytes, 0), folders: found.map((f) => ({ name: f.folderName, special: f.special, count: f.count, bytes: f.bytes })) };
  });

  async function purge(id, target, mode, permanent, reason) {
    const key = `${id}|${mode}|${target}`;
    const p = provider(id);
    const cached = previews.get(key);
    const found = cached && Date.now() - cached.at < 5 * 60 * 1000 ? cached.found : await p.findFromSender(target, mode, { onProgress: (t) => progress(t, { busy: true }) });
    previews.delete(key);
    const r = await p.purgeFound(found, permanent, { onProgress: (t) => progress(t, { busy: true }) });
    cache.removeSender(id, target, mode);
    if (r.count) store.logActivity({ accountId: id, email: label(id), action: permanent ? 'delete-sender' : 'trash-sender', target: reason || target, count: r.count, bytes: r.bytes, permanent });
    return { count: r.count, bytes: r.bytes, undoable: permanent ? false : remember(id, r.undo) };
  }
  handle('sender:purge', (id, value, mode = 'sender', permanent = false) => purge(id, normAddr(value).replace(/^@/, ''), mode, permanent));

  // many senders and/or many accounts at once, behind one confirmation
  handle('sender:previewMany', async (targets) => {
    const byAccount = new Map();
    for (const t of targets || []) {
      const value = normAddr(t.value).replace(/^@/, '');
      if (!value || !store.getAccount(t.accountId)) continue;
      if (!byAccount.has(t.accountId)) byAccount.set(t.accountId, []);
      byAccount.get(t.accountId).push({ value, mode: t.mode || 'sender' });
    }
    const found = [];
    for (const [accountId, list] of byAccount) {
      progress(`Looking through every folder in ${label(accountId)}`, { busy: true });
      found.push({ accountId, targets: list, found: await provider(accountId).findMatching(list, { onProgress: (t) => progress(t, { busy: true }) }) });
    }
    const token = crypto.randomUUID();
    multiPreviews.set(token, { found, at: Date.now() });
    setTimeout(() => multiPreviews.delete(token), 10 * 60 * 1000);
    const accounts = found.map((a) => ({
      accountId: a.accountId,
      email: label(a.accountId),
      count: a.found.reduce((s, f) => s + f.count, 0),
      bytes: a.found.reduce((s, f) => s + f.bytes, 0),
      folders: a.found.map((f) => ({ name: f.folderName, special: f.special, count: f.count, bytes: f.bytes })),
    }));
    const count = accounts.reduce((s, a) => s + a.count, 0);
    progress(`Found ${plural(count, 'email')}`);
    return { token, count, bytes: accounts.reduce((s, a) => s + a.bytes, 0), accounts };
  });
  handle('sender:purgeMany', async (token, permanent = false) => {
    const pre = multiPreviews.get(token);
    if (!pre) throw new UserError('That search is out of date. Please try again.');
    multiPreviews.delete(token);
    let count = 0;
    let bytes = 0;
    const undoAccounts = [];
    for (const a of pre.found) {
      const r = await provider(a.accountId).purgeFound(a.found, permanent, { onProgress: (t) => progress(t, { busy: true }) });
      count += r.count;
      bytes += r.bytes;
      for (const t of a.targets) cache.removeSender(a.accountId, t.value, t.mode);
      if (!permanent && remember(a.accountId, r.undo)) undoAccounts.push(a.accountId);
      if (r.count) {
        const what = a.targets.length === 1 ? a.targets[0].value : `${a.targets.length} senders`;
        store.logActivity({ accountId: a.accountId, email: label(a.accountId), action: permanent ? 'delete-sender' : 'trash-sender', target: what, count: r.count, bytes: r.bytes, permanent });
      }
    }
    return { count, bytes, undoAccounts };
  });

  // blocked senders (checked by this app)
  handle('rules:list', (id) => ({ rules: store.rulesFor(id), intervalMin: store.settings.ruleIntervalMin }));
  handle('rules:create', async (id, { mode = 'sender', value, action = 'trash', cleanup = false }) => {
    const target = normAddr(value).replace(/^@/, '');
    if (mode === 'sender' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(target)) throw new UserError('That doesn’t look like a full email address.');
    if (mode === 'domain' && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(target)) throw new UserError('Type a website-style name, like example.com.');
    const rule = store.addRule(id, { id: crypto.randomUUID(), mode, value: target, action, createdAt: Date.now(), lastRun: null });
    store.logActivity({ accountId: id, email: label(id), action: 'block', target, count: 0, bytes: 0 });
    const cleaned = cleanup ? await purge(id, target, mode, action === 'permanent') : null;
    return { rule, cleaned };
  });
  handle('rules:delete', (id, ruleId) => {
    store.removeRule(id, ruleId);
    return true;
  });
  handle('rules:runNow', () => runRules({ manual: true }));

  // analytics
  handle('analytics:status', (id) => cache.folders(id).map((d) => ({ folderId: d.folderId, folderName: d.folderName, scannedAt: d.scannedAt })));
  handle('analytics:scan', async (id, folderId, folderName) => {
    const prev = cache.load(id, folderId);
    progress(`Checking ${folderName}`, { busy: true });
    const res = await provider(id).scanFolder(folderId, prev, ({ done, total }) => {
      send('scan', { accountId: id, folderId, done, total });
      progress(`Checking ${folderName}: ${done.toLocaleString()} of ${total.toLocaleString()} emails`, { busy: true });
    });
    const data = { folderId, folderName, uidValidity: res.uidValidity, scannedAt: Date.now(), records: res.records };
    cache.save(id, folderId, data);
    progress(`Checked ${plural(Object.keys(res.records).length, 'email')} in ${folderName}`);
    return { count: Object.keys(res.records).length };
  });
  // scopes: [{ accountId, folderId }] — one or more folders, possibly in different accounts
  handle('analytics:getMany', (scopes) => summarizeMany(scopes || []));
  handle('analytics:detailMany', (scopes, value, mode = 'sender') => analytics.detail(mergedRecords(scopes || []).list, value, mode).slice(0, 3000));
  handle('analytics:olderMany', (scopes, days) => {
    const cutoff = Date.now() - days * 86400000;
    return (scopes || []).map((sc, x) => {
      const data = cache.load(sc.accountId, sc.folderId);
      const list = data ? Object.values(data.records).filter((r) => r.d && r.d < cutoff && !r.p) : [];
      return { x, accountId: sc.accountId, folderId: sc.folderId, ids: list.map((r) => r.i), bytes: list.reduce((s, r) => s + r.z, 0) };
    });
  });

  // unsubscribe
  handle('unsub:get', (id, folderId, msgId) => provider(id).getUnsubscribe(folderId, msgId));
  handle('unsub:run', async (id, folderId, msgId, method, info) => {
    const u = info || (await provider(id).getUnsubscribe(folderId, msgId));
    if (!u) throw new UserError('This email has no unsubscribe link.');
    if (method === 'oneclick' && u.oneClick && u.http) {
      const res = await fetch(u.http, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'QuietInbox/1.0' }, body: 'List-Unsubscribe=One-Click', redirect: 'follow' });
      if (!res.ok) throw new UserError('The sender didn’t accept the request. Try “Open the unsubscribe page” instead.');
      store.logActivity({ accountId: id, email: label(id), action: 'unsubscribe', target: new URL(u.http).hostname, count: 0, bytes: 0 });
      return { done: true };
    }
    if (method === 'mail' && u.mailto) {
      await shell.openExternal(u.mailto);
      return { done: false, opened: 'mail' };
    }
    if (u.http) {
      await shell.openExternal(u.http);
      return { done: false, opened: 'browser' };
    }
    throw new UserError('This sender has no unsubscribe page.');
  });

  handle('activity:list', () => ({ entries: store.activity.slice(0, 300), freed: store.freedBytes() }));
  handle('cache:clear', () => {
    cache.clear(null);
    return true;
  });
}

function mergedRecords(scopes) {
  const list = [];
  const info = scopes.map((sc, x) => {
    const data = cache.load(sc.accountId, sc.folderId);
    if (data) for (const r of Object.values(data.records)) list.push({ ...r, x });
    return { ...sc, email: label(sc.accountId), folderName: data?.folderName || sc.folderName || '', scannedAt: data?.scannedAt || null };
  });
  return { list, info };
}

function summarizeMany(scopes) {
  const { list, info } = mergedRecords(scopes);
  const scanned = info.filter((i) => i.scannedAt);
  if (!scanned.length) return null;
  const accounts = [...new Set(scopes.map((s) => s.accountId))];
  return {
    ...analytics.analyze(list),
    scopes: info,
    missing: info.filter((i) => !i.scannedAt).length,
    scannedAt: Math.min(...scanned.map((i) => i.scannedAt)),
    freed: accounts.reduce((s, a) => s + store.freedBytes(a), 0),
  };
}

// ---------- blocked senders ----------

function runRules(opts) {
  if (!rulesRunning) rulesRunning = doRunRules(opts).finally(() => (rulesRunning = null));
  return rulesRunning;
}

async function doRunRules({ manual = false } = {}) {
  let total = 0;
  for (const account of store.accounts) {
    const rules = store.rulesFor(account.id);
    if (!rules.length) continue;
    const p = provider(account.id);
    for (const action of ['trash', 'permanent']) {
      const batch = rules.filter((r) => r.action === action);
      if (!batch.length) continue;
      try {
        const found = await p.findMatching(batch.map((r) => ({ value: r.value, mode: r.mode })), { specials: ['inbox', 'junk'] });
        if (found.length) {
          const r = await p.purgeFound(found, action === 'permanent');
          total += r.count;
          if (r.count) store.logActivity({ accountId: account.id, email: account.email, action: 'blocked', target: 'blocked senders', count: r.count, bytes: r.bytes, permanent: action === 'permanent' });
          for (const f of found) cache.removeIds(account.id, f.folderId, f.ids.map(String));
        }
        for (const r of batch) r.lastRun = Date.now();
      } catch (e) {
        progress(`Couldn’t check blocked senders for ${account.email}: ${e.message}`, { error: true });
      }
    }
    store.saveRules();
  }
  if (total || manual) progress(total ? `Removed ${plural(total, 'email')} from blocked senders` : 'Checked blocked senders. Nothing new.');
  lastRulesText = `Checked blocked senders at ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${total ? `, removed ${plural(total, 'email')}` : ''}`;
  if (tray) tray.setToolTip(`Quiet Inbox\n${lastRulesText}`);
  send('rules-ran', { total });
  return { total };
}

function scheduleRules() {
  if (ruleTimer) clearInterval(ruleTimer);
  const min = Math.max(5, Number(store.settings.ruleIntervalMin) || 15);
  ruleTimer = setInterval(() => runRules().catch(() => {}), min * 60 * 1000);
}

// ---------- links ----------

async function confirmAndOpen(url, message = 'Open this link in your web browser?') {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!['http:', 'https:', 'mailto:'].includes(u.protocol)) return false;
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Open link', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message,
    detail: `It goes to: ${u.protocol === 'mailto:' ? url : u.hostname}\n\nIf you weren’t expecting this email, it’s safer not to open its links.`,
  });
  if (response !== 0) return false;
  await shell.openExternal(u.toString());
  return true;
}

// ---------- window ----------

function createWindow() {
  const t = nativeTheme.shouldUseDarkColors ? THEME.dark : THEME.light;
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 640,
    show: false,
    backgroundColor: t.bg,
    title: 'Quiet Inbox',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? undefined : { color: t.bg, symbolColor: t.symbol, height: 44 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    confirmAndOpen(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault();
  });
  // Email bodies live in a sandboxed iframe; a link must never load a remote page inside it.
  win.webContents.on('will-frame-navigate', (details) => {
    if (!details.isMainFrame && !/^about:/.test(details.url)) {
      details.preventDefault();
      confirmAndOpen(details.url);
    }
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
      win.webContents.toggleDevTools();
      e.preventDefault();
    }
  });
  win.webContents.on('did-finish-load', applyZoom);
  win.on('close', (e) => {
    if (quitting || !store.settings.runInBackground || !tray) return;
    // Closing the window keeps Quiet Inbox in the tray so blocked senders keep getting removed.
    e.preventDefault();
    win.hide();
    if (!store.settings.trayHintShown && process.platform === 'win32') {
      tray.displayBalloon({ iconType: 'info', title: 'Quiet Inbox is still running', content: 'It keeps removing blocked senders in the background. Click the Quiet Inbox icon here to open it again.' });
      store.updateSettings({ trayHintShown: true });
    }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (startHidden && tray) return; // started with Windows: stay in the tray
    win.maximize();
    win.show();
  });
  win.on('closed', () => (win = null));
}

function showWindow() {
  if (!win) return createWindow();
  if (!win.isVisible()) win.maximize();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function applyStartup() {
  if (!app.isPackaged || process.platform !== 'win32') return;
  app.setLoginItemSettings({ openAtLogin: !!store.settings.startWithWindows, args: ['--hidden'] });
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Quiet Inbox', click: showWindow },
      { label: 'Check blocked senders now', click: () => runRules({ manual: true }).catch(() => {}) },
      { type: 'separator' },
      { label: 'Start when Windows starts', type: 'checkbox', checked: !!store.settings.startWithWindows, click: (i) => (store.updateSettings({ startWithWindows: i.checked }), applyStartup(), send('settings-changed', store.publicSettings())) },
      { label: 'Keep running when the window is closed', type: 'checkbox', checked: !!store.settings.runInBackground, click: (i) => (store.updateSettings({ runInBackground: i.checked }), send('settings-changed', store.publicSettings())) },
      { type: 'separator' },
      {
        label: 'Quit Quiet Inbox',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
}

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  } catch {
    tray = null;
    return;
  }
  tray.setToolTip(`Quiet Inbox\n${lastRulesText}`);
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  updateTrayMenu();
}

app.on('second-instance', showWindow);
app.on('before-quit', () => {
  quitting = true;
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  if (process.env.QUIET_INBOX_DATA) app.setPath('userData', process.env.QUIET_INBOX_DATA);
  const dataDir = app.getPath('userData');
  store = new Store(dataDir, secretBox);
  oauthConfig = loadOAuthConfig();
  // Carry over accounts and settings from when the app was called Spam Sweep.
  try {
    const old = path.join(app.getPath('appData'), 'Spam Sweep');
    if (!process.env.QUIET_INBOX_DATA && fs.existsSync(path.join(old, 'accounts.json')) && !fs.existsSync(path.join(dataDir, 'accounts.json'))) {
      fs.cpSync(old, dataDir, { recursive: true, force: false, errorOnExist: false });
      store = new Store(dataDir, secretBox);
    }
  } catch {
    /* nothing to migrate */
  }
  // Turn on "start with Windows" once on a fresh install, so blocked senders work without her opening the app.
  if (!store.settings.startupApplied) {
    store.updateSettings({ startupApplied: true });
    applyStartup();
  }
  cache = new Cache(path.join(dataDir, 'cache'));
  nativeTheme.themeSource = store.settings.theme || 'light';
  registerIpc();
  createTray();
  createWindow();
  scheduleRules();
  // Clear out blocked senders as soon as the app opens, before she starts reading.
  setTimeout(() => runRules().catch(() => {}), 1500);
  if (process.env.QUIET_INBOX_SELFTEST) require(path.join(__dirname, '..', '..', 'test', 'ui-selftest.js')).run(win);
});

app.on('window-all-closed', async () => {
  if (tray && store.settings.runInBackground && !quitting) return;
  for (const p of providers.values()) await p.close().catch(() => {});
  app.quit();
});
