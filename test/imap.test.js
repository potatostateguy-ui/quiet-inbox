'use strict';
// End-to-end test of the IMAP provider against a throwaway local IMAP server (Dovecot on 127.0.0.1:1143, user test@example.com / secret), seeded by test/seed.js.
const assert = require('assert');
const { ImapProvider } = require('../src/main/providers/imap');
const { analyze, detail } = require('../src/main/analytics');

const account = { id: 't', email: 'test@example.com', kind: 'imap', imap: { host: '127.0.0.1', port: 1143, security: 'none', user: 'test@example.com' } };
const p = new ImapProvider(account, { getAuth: async () => ({ user: 'test@example.com', pass: 'secret' }) });

(async () => {
  const t0 = Date.now();
  const folders = await p.listFolders();
  console.log('folders:', folders.map((f) => `${f.name}[${f.special || '-'}] ${f.total}/${f.unread}`).join(', '));
  assert.deepStrictEqual(folders.slice(0, 3).map((f) => f.special), ['inbox', 'junk', 'trash']);
  const inbox = folders.find((f) => f.special === 'inbox');
  assert.strictEqual(inbox.total, 240);

  // paging
  const page1 = await p.listMessages('INBOX', { pageSize: 50 });
  assert.strictEqual(page1.items.length, 50);
  assert.strictEqual(page1.total, 240);
  const page2 = await p.listMessages('INBOX', { pageSize: 50, cursor: page1.nextCursor });
  assert.ok(Number(page2.items[0].id) < Number(page1.items[49].id), 'page 2 continues below page 1');
  const withAtt = (await p.listMessages('INBOX', { query: 'Photos from the trip' })).items;
  assert.ok(withAtt.length === 25 && withAtt.every((m) => m.hasAttachments), 'attachment detection + search');
  const news = page1.items.find((m) => m.from.address === 'news@bigretail.com') || (await p.listMessages('INBOX', { query: 'Flash sale' })).items[0];
  assert.ok(news.unsubscribe, 'list-unsubscribe detected');

  // open a message
  const msg = await p.getMessage('INBOX', news.id);
  assert.ok(msg.html.includes('Flash sale'));
  assert.deepStrictEqual(msg.auth, { spf: 'pass', dkim: 'pass', dmarc: 'pass' });
  assert.ok(msg.unsubscribe.oneClick && msg.unsubscribe.http.startsWith('https://unsub.example.com/'));
  assert.ok(msg.unsubscribe.mailto.startsWith('mailto:'));
  const u = await p.getUnsubscribe('INBOX', news.id);
  assert.ok(u.oneClick);
  const pdf = await p.getMessage('INBOX', withAtt[0].id);
  assert.strictEqual(pdf.attachments[0].name, 'report.pdf');

  // analytics scan
  const scan = await p.scanFolder('INBOX', null, () => {});
  const a = analyze(scan.records);
  assert.strictEqual(a.totals.count, 240);
  assert.strictEqual(a.sendersBySize[0].address, 'friend@gmail.com');
  assert.ok(a.lists.some((s) => s.address === 'news@bigretail.com'));
  assert.ok(a.neverOpened.some((s) => s.address === 'win1@sketchy.biz'));
  console.log('top by size:', a.sendersBySize.slice(0, 4).map((s) => `${s.address} ${(s.bytes / 1e6).toFixed(1)}MB x${s.count}`).join(' | '));
  console.log('half of space from', a.halfCount, 'senders; unread', a.totals.unread);
  assert.strictEqual(detail(scan.records, 'sketchy.biz', 'domain').length, 25);

  // incremental rescan keeps records and drops deleted
  const rescan = await p.scanFolder('INBOX', scan, () => {});
  assert.strictEqual(Object.keys(rescan.records).length, 240);

  // exact sender match: "bob@shop.io" must not catch "jimbob@shop.io"
  const bob = await p.findFromSender('bob@shop.io', 'sender');
  assert.strictEqual(bob.reduce((s, f) => s + f.count, 0), 6);
  // domain match includes subdomains, across folders (INBOX + Archive)
  const retail = await p.findFromSender('bigretail.com', 'domain');
  const retailCount = retail.reduce((s, f) => s + f.count, 0);
  assert.strictEqual(retailCount, 160, `bigretail domain count ${retailCount}`);
  assert.ok(retail.some((f) => f.special === 'archive'));

  // single trash + permanent delete
  const one = page1.items[0];
  await p.trash('INBOX', [one.id]);
  let trashList = await p.listMessages('Trash');
  assert.strictEqual(trashList.items.length, 1);
  const d = await p.destroy('Trash', [trashList.items[0].id]);
  assert.ok(d.count === 1 && d.bytes > 0);
  trashList = await p.listMessages('Trash');
  assert.strictEqual(trashList.items.length, 0);

  // purge sender across folders (spam in INBOX and Junk), permanently
  const spam = await p.findFromSender('win1@sketchy.biz', 'sender');
  assert.strictEqual(spam.reduce((s, f) => s + f.count, 0), 40);
  const purge = await p.purgeFound(spam, true);
  assert.strictEqual(purge.count, 40);
  assert.strictEqual((await p.findFromSender('win1@sketchy.biz')).length, 0);

  // trash-all for a domain: moves INBOX + Archive copies to Trash
  const moved = await p.purgeFound(retail, false);
  assert.strictEqual(moved.count, 160);
  const t = await p.listFolders();
  assert.strictEqual(t.find((f) => f.special === 'trash').total, 160);

  // app-rule style multi-target search limited to inbox/junk
  const cloudLeft = (await p.findFromSender('cloud.example', 'domain')).reduce((s, f) => s + f.count, 0);
  const rules = await p.findMatching([{ value: 'win2@sketchy.biz', mode: 'sender' }, { value: 'cloud.example', mode: 'domain' }], { specials: ['inbox', 'junk'] });
  assert.strictEqual(rules.reduce((s, f) => s + f.count, 0), 20 + cloudLeft);

  // junk + mark read
  const anyInbox = (await p.listMessages('INBOX', { pageSize: 2 })).items;
  await p.markRead('INBOX', [anyInbox[0].id], false);
  await p.junk('INBOX', [anyInbox[1].id]);
  const after = await p.listFolders();
  assert.strictEqual(after.find((f) => f.special === 'junk').total, 21);

  await p.close();
  console.log(`IMAP provider: all checks passed in ${Date.now() - t0} ms`);
})().catch(async (e) => {
  console.error('FAILED:', e);
  await p.close();
  process.exit(1);
});
