'use strict';

const dns = require('dns').promises;
const { PRESETS } = require('./presets');

const MX_RULES = [
  [/(^|\.)google(mail)?\.com$|aspmx/i, 'gmail'],
  [/outlook\.com$|office365|protection\.outlook|hotmail/i, 'outlook'],
  [/yahoodns\.net$|yahoo\.com$/i, 'yahoo'],
  [/icloud\.com$|me\.com$/i, 'icloud'],
  [/aol\.com$/i, 'aol'],
  [/messagingengine\.com$|fastmail/i, 'fastmail'],
  [/zoho\.(com|eu)$/i, 'zoho'],
  [/protonmail\.ch$/i, 'proton'],
  [/gmx\.(net|com|de)$/i, 'gmx'],
];

const withPreset = (key, extra = {}) => ({ key, ...PRESETS[key], ...extra });

async function fromIspdb(domain) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  try {
    const res = await fetch(`https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}`, { signal: ctl.signal });
    if (!res.ok) return null;
    const xml = await res.text();
    const block = xml.match(/<incomingServer[^>]*type="imap"[^>]*>([\s\S]*?)<\/incomingServer>/i);
    if (!block) return null;
    const tag = (n) => (block[1].match(new RegExp(`<${n}>([^<]+)</${n}>`, 'i')) || [])[1];
    const host = tag('hostname');
    if (!host) return null;
    const socket = (tag('socketType') || 'SSL').toUpperCase();
    return { host, port: Number(tag('port')) || 993, security: socket === 'STARTTLS' ? 'starttls' : socket === 'PLAIN' ? 'none' : 'tls' };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Works out the IMAP settings from an email address: known domain, then MX records, then Thunderbird's database. */
async function discover(email) {
  const domain = String(email || '').split('@')[1]?.trim().toLowerCase();
  if (!domain) return null;
  for (const [key, p] of Object.entries(PRESETS)) if (p.domains.includes(domain)) return withPreset(key);
  try {
    const mx = await dns.resolveMx(domain);
    for (const { exchange } of mx.sort((a, b) => a.priority - b.priority)) {
      for (const [re, key] of MX_RULES) {
        // A custom domain on Microsoft 365 is a work or school account, not a personal one.
        if (re.test(exchange)) return withPreset(key, key === 'outlook' ? { hostedDomain: domain, tenant: 'organizations' } : { hostedDomain: domain });
      }
    }
  } catch {
    /* no MX or offline */
  }
  const isp = await fromIspdb(domain);
  if (isp) return { ...PRESETS.other, key: 'other', ...isp, label: domain, found: true };
  return { ...PRESETS.other, key: 'other', host: `imap.${domain}`, label: domain, guessed: true };
}

module.exports = { discover };
