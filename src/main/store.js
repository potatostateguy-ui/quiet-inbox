'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
  markReadOnOpen: true,
  remoteImages: false,
  ruleIntervalMin: 15,
  theme: 'light',
  textSize: 'normal',
  showAllFolders: false,
  runInBackground: true,
  startWithWindows: true,
  trayHintShown: false,
  startupApplied: false,
  microsoftClientId: '',
};

/**
 * crypto: { seal(str) -> string, unseal(string) -> str } — Electron safeStorage (DPAPI on Windows) in the app,
 * a passthrough in tests.
 */
class Store {
  constructor(dir, crypto, bundledOAuth = {}) {
    this.dir = dir;
    this.crypto = crypto;
    this.bundledOAuth = bundledOAuth;
    fs.mkdirSync(dir, { recursive: true });
    this.accounts = this._read('accounts.json', []);
    this.settings = { ...DEFAULT_SETTINGS, ...this._read('settings.json', {}) };
    this.appRules = this._read('rules.json', {});
    this.activity = this._read('activity.json', []);
  }

  _read(name, fallback) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
    } catch {
      return fallback;
    }
  }

  _write(name, data) {
    const file = path.join(this.dir, name);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, file);
  }

  seal(s) {
    return this.crypto.seal(s);
  }

  unseal(s) {
    return this.crypto.unseal(s);
  }

  // ---------- settings ----------

  publicSettings() {
    return { ...this.settings };
  }

  updateSettings(patch) {
    for (const [k, v] of Object.entries(patch || {})) if (k in DEFAULT_SETTINGS) this.settings[k] = v;
    this._write('settings.json', this.settings);
    return this.publicSettings();
  }

  // ---------- accounts ----------

  getAccount(id) {
    return this.accounts.find((a) => a.id === id) || null;
  }

  upsertAccount(account) {
    const i = this.accounts.findIndex((a) => a.id === account.id || (a.email === account.email && a.kind === account.kind));
    if (i >= 0) {
      account.id = this.accounts[i].id;
      this.accounts[i] = account;
    } else this.accounts.push(account);
    this.saveAccounts();
    return account;
  }

  removeAccount(id) {
    this.accounts = this.accounts.filter((a) => a.id !== id);
    delete this.appRules[id];
    this.saveAccounts();
    this.saveRules();
  }

  saveAccounts() {
    this._write('accounts.json', this.accounts);
  }

  // ---------- app-side rules (for IMAP accounts without a rules API) ----------

  rulesFor(id) {
    return this.appRules[id] || [];
  }

  addRule(accountId, rule) {
    const list = (this.appRules[accountId] = this.rulesFor(accountId));
    const dupe = list.find((r) => r.mode === rule.mode && r.value === rule.value);
    if (dupe) {
      dupe.action = rule.action;
      this.saveRules();
      return dupe;
    }
    list.push(rule);
    this.saveRules();
    return rule;
  }

  removeRule(accountId, ruleId) {
    this.appRules[accountId] = this.rulesFor(accountId).filter((r) => r.id !== ruleId);
    this.saveRules();
  }

  saveRules() {
    this._write('rules.json', this.appRules);
  }

  // ---------- activity log ----------

  logActivity(entry) {
    this.activity.unshift({ ts: Date.now(), ...entry });
    if (this.activity.length > 1000) this.activity.length = 1000;
    this._write('activity.json', this.activity);
  }

  freedBytes(accountId) {
    return this.activity.filter((a) => a.permanent && (!accountId || a.accountId === accountId)).reduce((s, a) => s + (a.bytes || 0), 0);
  }
}

module.exports = { Store, DEFAULT_SETTINGS };
