'use strict';
// Starring, starred-mail protection, and whole-folder actions (run after test/seed.js).
const assert = require('assert');
const { ImapProvider } = require('../src/main/providers/imap');
const { analyze, toRecord } = require('../src/main/analytics');
const p = new ImapProvider({ id: 't', email: 'test@example.com', imap: { host: '127.0.0.1', port: 1143, security: 'none' } }, { getAuth: async () => ({ user: 'test@example.com', pass: 'secret' }) });

(async () => {
  const news = (await p.listMessages('INBOX', { query: 'Flash sale' })).items;
  const keep = news.slice(0, 3).map((m) => m.id);
  await p.flag('INBOX', keep, true);
  const again = (await p.listMessages('INBOX', { query: 'Flash sale' })).items;
  assert.strictEqual(again.filter((m) => m.flagged).length, 3, 'stars stick');

  // Sender-wide delete leaves starred mail alone
  const found = await p.findFromSender('news@bigretail.com');
  const total = found.reduce((s, f) => s + f.count, 0);
  assert.strictEqual(total, 130 - 3, `starred excluded from sender search (${total})`);
  await p.purgeFound(found, true);
  const left = (await p.listMessages('INBOX', { query: 'Flash sale' })).items;
  assert.deepStrictEqual(left.map((m) => m.id).sort(), keep.slice().sort(), 'only starred ones remain');

  // Scan records the star and keeps starred mail out of the "old emails" counts
  const scan = await p.scanFolder('INBOX', null, () => {});
  const recs = Object.values(scan.records);
  assert.strictEqual(recs.filter((r) => r.p).length, 3);
  const a = analyze(recs.map((r) => ({ ...r, x: 0 })));
  assert.strictEqual(a.ages.reduce((s, b) => s + b.count, 0), recs.length - 3);
  assert.ok(Array.isArray(a.sendersBySize[0].xs));

  // Whole-folder trash keeps starred mail and is undoable
  const before = (await p.listFolders()).find((f) => f.special === 'inbox').total;
  const t = await p.trashAll('INBOX');
  assert.strictEqual(t.count, before - 3);
  assert.strictEqual((await p.listFolders()).find((f) => f.special === 'inbox').total, 3);
  const back = await p.restore(t.undo);
  assert.strictEqual(back.count, before - 3, 'undo brings everything back');
  // Whole-folder delete forever (Junk), again sparing a starred one
  const junk = (await p.listMessages('Junk')).items;
  await p.flag('Junk', [junk[0].id], true);
  const d = await p.destroyAll('Junk');
  assert.strictEqual(d.count, junk.length - 1);
  assert.strictEqual((await p.listMessages('Junk')).items.length, 1);
  await p.close();
  console.log('Starred protection and whole-folder actions: all checks passed');
})().catch(async (e) => {
  console.error('FAILED', e);
  await p.close();
  process.exit(1);
});
