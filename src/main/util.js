'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** [1,2,3,7,9,10] -> "1:3,7,9:10" — keeps IMAP command lines short. */
function compactRange(nums) {
  const sorted = [...new Set(nums.map(Number))].sort((a, b) => a - b);
  const parts = [];
  let start = null;
  let prev = null;
  for (const n of sorted) {
    if (start === null) {
      start = prev = n;
    } else if (n === prev + 1) {
      prev = n;
    } else {
      parts.push(start === prev ? `${start}` : `${start}:${prev}`);
      start = prev = n;
    }
  }
  if (start !== null) parts.push(start === prev ? `${start}` : `${start}:${prev}`);
  return parts.join(',');
}

const normAddr = (a) => String(a || '').trim().toLowerCase();

function domainOf(address) {
  const a = normAddr(address);
  const at = a.lastIndexOf('@');
  return at >= 0 ? a.slice(at + 1) : '';
}

/** mode 'sender' = exact address, mode 'domain' = domain or any subdomain of it. */
function matchesTarget(address, target, mode) {
  const a = normAddr(address);
  const t = normAddr(target).replace(/^@/, '');
  if (!a || !t) return false;
  if (mode === 'domain') {
    const d = domainOf(a);
    return d === t || d.endsWith('.' + t);
  }
  return a === t;
}

/**
 * List-Unsubscribe: <https://x/unsub?id=1>, <mailto:unsub@x.com?subject=bye>
 * List-Unsubscribe-Post: List-Unsubscribe=One-Click   (RFC 8058)
 */
function parseUnsubscribe(listUnsub, listUnsubPost) {
  if (!listUnsub) return null;
  const urls = [...String(listUnsub).matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
  const http = urls.find((u) => /^https?:\/\//i.test(u)) || null;
  const mailto = urls.find((u) => /^mailto:/i.test(u)) || null;
  if (!http && !mailto) return null;
  const oneClick = !!http && /^https:/i.test(http) && /list-unsubscribe\s*=\s*one-click/i.test(listUnsubPost || '');
  return { http, mailto, oneClick };
}

/** Pull spf/dkim/dmarc verdicts out of Authentication-Results headers. */
function parseAuthResults(headerText) {
  if (!headerText) return null;
  const unfolded = String(headerText).replace(/\r?\n[ \t]+/g, ' ');
  const lines = unfolded.split(/\r?\n/).filter((l) => /^(arc-)?authentication-results:/i.test(l));
  // Prefer the top-most (most recent, added by the receiving server) non-ARC header.
  const line = lines.find((l) => /^authentication-results:/i.test(l)) || lines[0];
  if (!line) return null;
  const pick = (k) => {
    const m = line.match(new RegExp(`\\b${k}\\s*=\\s*([a-z]+)`, 'i'));
    return m ? m[1].toLowerCase() : null;
  };
  const res = { spf: pick('spf'), dkim: pick('dkim'), dmarc: pick('dmarc') };
  return res.spf || res.dkim || res.dmarc ? res : null;
}

function headerValue(headerText, name) {
  if (!headerText) return null;
  const unfolded = String(headerText).replace(/\r?\n[ \t]+/g, ' ');
  const re = new RegExp(`^${name}:\\s*(.*)$`, 'im');
  const m = unfolded.match(re);
  return m ? m[1].trim() : null;
}

/** The email body is rendered in a sandboxed, script-less iframe; this strips the few things that would still act. */
function sanitizeEmailHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*>/gi, '')
    .replace(/<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]*>/gi, '')
    .replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy[^>]*>/gi, '')
    .replace(/<base\b[^>]*>/gi, '');
}

const SPECIAL_ORDER = ['inbox', 'junk', 'trash', 'archive', 'all', 'sent', 'drafts'];

/**
 * folders: [{ id, parentId, name, special }]. Returns them in tree order with
 * well-known folders first at the top level and children directly under their parent.
 */
function sortFolderTree(folders) {
  const byParent = new Map();
  for (const f of folders) {
    const key = f.parentId || '';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(f);
  }
  const ids = new Set(folders.map((f) => f.id));
  const rank = (f) => {
    const i = SPECIAL_ORDER.indexOf(f.special);
    return i === -1 ? 100 : i;
  };
  const out = [];
  const visit = (key, depth) => {
    const kids = (byParent.get(key) || []).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    for (const k of kids) {
      out.push({ ...k, depth });
      visit(k.id, depth + 1);
    }
  };
  visit('', 0);
  // Orphans whose parent was not listed
  for (const f of folders) {
    if (f.parentId && !ids.has(f.parentId) && !out.find((o) => o.id === f.id)) {
      out.push({ ...f, depth: 0 });
      visit(f.id, 1);
    }
  }
  return out;
}

class UserError extends Error {
  constructor(message) {
    super(message);
    this.userFacing = true;
  }
}

module.exports = {
  sleep,
  chunk,
  compactRange,
  normAddr,
  domainOf,
  matchesTarget,
  parseUnsubscribe,
  parseAuthResults,
  headerValue,
  sanitizeEmailHtml,
  sortFolderTree,
  UserError,
};
