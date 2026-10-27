'use strict';
// Seeds a local IMAP server with a realistic mix of mail for testing.
const { ImapFlow } = require('imapflow');
const crypto = require('crypto');

const DAY = 864e5;
const rnd = (n) => Math.floor(Math.random() * n);

function message({ from, name, subject, date, kb = 4, unsub = false, oneClick = false, attachKb = 0, auth = 'pass' }) {
  const id = crypto.randomBytes(8).toString('hex');
  const body = ('Lorem ipsum dolor sit amet, consectetur adipiscing elit. ').repeat(Math.ceil((kb * 1024) / 57)).slice(0, kb * 1024);
  const headers = [
    `Authentication-Results: mx.example.com; spf=${auth} smtp.mailfrom=${from}; dkim=${auth} header.d=${from.split('@')[1]}; dmarc=${auth === 'pass' ? 'pass' : 'fail'}`,
    `From: "${name}" <${from}>`,
    'To: test@example.com',
    `Subject: ${subject}`,
    `Date: ${new Date(date).toUTCString()}`,
    `Message-ID: <${id}@${from.split('@')[1]}>`,
    'MIME-Version: 1.0',
  ];
  if (unsub) headers.push(`List-Unsubscribe: <https://unsub.example.com/u/${id}>, <mailto:unsub@${from.split('@')[1]}?subject=unsubscribe>`);
  if (oneClick) headers.push('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  if (!attachKb) {
    headers.push('Content-Type: text/html; charset=utf-8');
    return headers.join('\r\n') + `\r\n\r\n<html><body><h1>${subject}</h1><p>${body}</p><img src="https://tracker.example.com/p.gif?${id}" width="1" height="1"><a href="https://example.com/offer">Shop now</a></body></html>\r\n`;
  }
  const boundary = 'b' + id;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const att = crypto.randomBytes(attachKb * 1024).toString('base64').replace(/(.{76})/g, '$1\r\n');
  return headers.join('\r\n') + `\r\n\r\n--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${subject}\r\n\r\n${body}\r\n--${boundary}\r\nContent-Type: application/pdf; name="report.pdf"\r\nContent-Disposition: attachment; filename="report.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${att}\r\n--${boundary}--\r\n`;
}

async function seed({ host = '127.0.0.1', port = 1143, user = 'test@example.com', pass = 'secret' } = {}) {
  const c = new ImapFlow({ host, port, secure: false, doSTARTTLS: false, auth: { user, pass }, logger: false });
  await c.connect();
  const now = Date.now();
  const plan = [
    { n: 120, folder: 'INBOX', from: 'news@bigretail.com', name: 'BigRetail', subject: (i) => `Flash sale #${i}: up to 70% off`, kb: 40, unsub: true, oneClick: true, read: 0.05 },
    { n: 30, folder: 'INBOX', from: 'promo@deals.bigretail.com', name: 'BigRetail Deals', subject: (i) => `Deal of the day ${i}`, kb: 20, unsub: true, read: 0.1 },
    { n: 20, folder: 'INBOX', from: 'alerts@bank.example', name: 'Bank Alerts', subject: (i) => `Your statement is ready (${i})`, kb: 3, read: 1 },
    { n: 25, folder: 'INBOX', from: 'friend@gmail.com', name: 'Sam Friend', subject: (i) => `Photos from the trip, part ${i}`, kb: 2, attachKb: 300, read: 1 },
    { n: 6, folder: 'INBOX', from: 'bob@shop.io', name: 'Bob', subject: (i) => `Order update ${i}`, kb: 2, read: 1 },
    { n: 9, folder: 'INBOX', from: 'jimbob@shop.io', name: 'Jim Bob', subject: (i) => `Jim's newsletter ${i}`, kb: 6, unsub: true, read: 0 },
    { n: 25, folder: 'INBOX', from: 'win1@sketchy.biz', name: 'Prize Desk', subject: (i) => `You have WON ${i}`, kb: 8, auth: 'fail', read: 0 },
    { n: 20, folder: 'Junk', from: 'win2@sketchy.biz', name: 'Prize Desk', subject: (i) => `Claim your reward ${i}`, kb: 8, auth: 'fail', read: 0 },
    { n: 15, folder: 'Junk', from: 'win1@sketchy.biz', name: 'Prize Desk', subject: (i) => `Final notice ${i}`, kb: 8, auth: 'fail', read: 0 },
    { n: 10, folder: 'Archive', from: 'news@bigretail.com', name: 'BigRetail', subject: (i) => `Archived promo ${i}`, kb: 40, unsub: true, read: 0 },
    { n: 5, folder: 'INBOX', from: 'photos@cloud.example', name: 'Cloud Photos', subject: (i) => `Your monthly photo backup ${i}`, kb: 2, attachKb: 1500, read: 0 },
  ];
  let total = 0;
  for (const p of plan) {
    for (let i = 1; i <= p.n; i++) {
      const date = now - rnd(6 * 365) * DAY - rnd(DAY);
      const raw = message({ ...p, subject: p.subject(i), date });
      const flags = Math.random() < p.read ? ['\\Seen'] : [];
      await c.append(p.folder, raw, flags, new Date(date));
      total++;
    }
  }
  await c.logout();
  return total;
}

module.exports = { seed };
if (require.main === module) seed({ user: process.env.SEED_USER || 'test@example.com' }).then((n) => console.log(`Seeded ${n} messages`)).catch((e) => { console.error(e); process.exit(1); });
