'use strict';

const { domainOf, matchesTarget } = require('./util');

/** Compact on-disk record. Keys are short because a big mailbox has 100k+ of these. */
function toRecord(s) {
  return {
    i: s.id,
    f: s.from.address || '',
    n: s.from.name || '',
    s: s.subject || '',
    d: s.date ? Date.parse(s.date) || 0 : 0,
    z: s.size || 0,
    r: s.seen ? 1 : 0,
    a: s.hasAttachments ? 1 : 0,
    u: s.unsubscribe ? 1 : 0,
    p: s.flagged ? 1 : 0,
  };
}

const DAY = 86400000;

function analyze(records, { now = Date.now(), top = 300 } = {}) {
  const list = Array.isArray(records) ? records : Object.values(records || {});
  const totals = { count: list.length, bytes: 0, unread: 0, lists: 0, listBytes: 0, attach: 0, attachBytes: 0 };
  const senders = new Map();
  const domains = new Map();
  const ages = [
    { label: 'Last 30 days', max: 30 },
    { label: '1–3 months', max: 91 },
    { label: '3–12 months', max: 365 },
    { label: '1–2 years', max: 730 },
    { label: '2–5 years', max: 1826 },
    { label: 'Over 5 years', max: Infinity },
  ].map((a) => ({ ...a, count: 0, bytes: 0 }));
  const months = new Map();

  for (const r of list) {
    totals.bytes += r.z;
    if (!r.r) totals.unread++;
    if (r.u) {
      totals.lists++;
      totals.listBytes += r.z;
    }
    if (r.a) {
      totals.attach++;
      totals.attachBytes += r.z;
    }

    const address = r.f || '(no sender)';
    let s = senders.get(address);
    if (!s) {
      s = { address, name: '', domain: domainOf(address), count: 0, bytes: 0, unread: 0, lists: 0, attach: 0, first: 0, last: 0, latestId: null, latestListId: null, latestListX: 0, xs: new Set() };
      senders.set(address, s);
    }
    s.count++;
    s.bytes += r.z;
    s.xs.add(r.x || 0);
    if (!r.r) s.unread++;
    if (r.a) s.attach++;
    if (r.u) {
      s.lists++;
      if (!s.latestListId || r.d >= s.latestListD) {
        s.latestListId = r.i;
        s.latestListX = r.x || 0;
        s.latestListD = r.d;
      }
    }
    if (r.d && (!s.first || r.d < s.first)) s.first = r.d;
    if (r.d >= s.last) {
      s.last = r.d;
      s.latestId = r.i;
      if (r.n) s.name = r.n;
    }
    if (!s.name && r.n) s.name = r.n;

    const dk = s.domain || '(no domain)';
    let d = domains.get(dk);
    if (!d) {
      d = { domain: dk, count: 0, bytes: 0, unread: 0, senders: new Set(), last: 0 };
      domains.set(dk, d);
    }
    d.count++;
    d.bytes += r.z;
    if (!r.r) d.unread++;
    d.senders.add(address);
    if (r.d > d.last) d.last = r.d;

    if (r.d && !r.p) {
      // Starred mail is never offered for bulk deletion, so it isn't counted as "old".
      const days = (now - r.d) / DAY;
      const bucket = ages.find((a) => days < a.max) || ages[ages.length - 1];
      bucket.count++;
      bucket.bytes += r.z;
      const mk = new Date(r.d).toISOString().slice(0, 7);
      const m = months.get(mk) || { count: 0, bytes: 0 };
      m.count++;
      m.bytes += r.z;
      months.set(mk, m);
    }
  }

  const all = [...senders.values()].map(({ latestListD, xs, ...s }) => ({ ...s, xs: [...xs] }));
  const bySize = all.slice().sort((a, b) => b.bytes - a.bytes || b.count - a.count);
  const byCount = all.slice().sort((a, b) => b.count - a.count || b.bytes - a.bytes);

  // How many of the biggest senders it takes to reach half of the folder's size.
  let acc = 0;
  let halfCount = 0;
  for (const s of bySize) {
    acc += s.bytes;
    halfCount++;
    if (acc >= totals.bytes / 2) break;
  }

  const monthList = [];
  const cur = new Date(now);
  for (let i = 23; i >= 0; i--) {
    const d = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() - i, 1));
    const key = d.toISOString().slice(0, 7);
    monthList.push({ key, ...(months.get(key) || { count: 0, bytes: 0 }) });
  }

  return {
    totals,
    senderCount: all.length,
    domainCount: domains.size,
    halfCount: totals.bytes ? halfCount : 0,
    strip: bySize.slice(0, 10).map((s) => ({ address: s.address, name: s.name, bytes: s.bytes, count: s.count })),
    sendersBySize: bySize.slice(0, top),
    sendersByCount: byCount.slice(0, top),
    domains: [...domains.values()]
      .map((d) => ({ ...d, senders: d.senders.size }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, top),
    lists: all
      .filter((s) => s.lists > 0 && s.lists >= s.count / 2)
      .sort((a, b) => b.count - a.count)
      .slice(0, top),
    neverOpened: all
      .filter((s) => s.count >= 3 && s.unread / s.count >= 0.9)
      .sort((a, b) => b.count - a.count || b.bytes - a.bytes)
      .slice(0, top),
    largest: list
      .slice()
      .sort((a, b) => b.z - a.z)
      .slice(0, 150),
    ages,
    months: monthList,
  };
}

/** Messages for one sender or domain, newest first. */
function detail(records, value, mode = 'sender') {
  const list = Array.isArray(records) ? records : Object.values(records || {});
  return list
    .filter((r) => (mode === 'sender' ? (r.f || '(no sender)') === value : matchesTarget(r.f, value, 'domain')))
    .sort((a, b) => b.d - a.d);
}

module.exports = { toRecord, analyze, detail };
