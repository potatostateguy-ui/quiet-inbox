'use strict';
// Runs the Microsoft sign-in flow against a mock login server: PKCE, state, loopback redirect, refresh rotation.
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const oauth = require('../src/main/oauth');

const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const idToken = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
const codes = new Map();
let refreshCount = 0;

const mock = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname === '/consumers/oauth2/v2.0/authorize') {
    const q = u.searchParams;
    assert.strictEqual(q.get('code_challenge_method'), 'S256');
    assert.ok(q.get('scope').includes('https://outlook.office.com/IMAP.AccessAsUser.All') && q.get('scope').includes('offline_access'));
    assert.strictEqual(q.get('login_hint'), 'nana@msn.com');
    assert.match(q.get('redirect_uri'), /^http:\/\/localhost:\d+$/);
    const code = b64url(crypto.randomBytes(8));
    codes.set(code, q.get('code_challenge'));
    res.writeHead(302, { Location: `${q.get('redirect_uri')}/?code=${code}&state=${q.get('state')}` }).end();
    return;
  }
  if (u.pathname === '/consumers/oauth2/v2.0/token') {
    let body = '';
    for await (const c of req) body += c;
    const p = new URLSearchParams(body);
    assert.strictEqual(p.get('client_id'), 'test-client');
    assert.ok(!p.get('client_secret'), 'public client sends no secret');
    if (p.get('grant_type') === 'authorization_code') {
      const challenge = codes.get(p.get('code'));
      assert.strictEqual(b64url(crypto.createHash('sha256').update(p.get('code_verifier')).digest()), challenge, 'PKCE verifier matches');
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, id_token: idToken({ preferred_username: 'Nana@MSN.com', name: 'Nana' }) }));
    } else {
      assert.strictEqual(p.get('refresh_token'), 'rt-1');
      refreshCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 }));
    }
    return;
  }
  res.writeHead(404).end();
});

mock.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${mock.address().port}`;
  try {
    // Pretend to be the browser: follow the authorize redirect to the loopback listener.
    const openExternal = async (url) => {
      const r = await fetch(url, { redirect: 'manual' });
      const page = await fetch(r.headers.get('location'));
      assert.match(await page.text(), /signed in/);
    };
    const t = await oauth.authorize({ clientId: 'test-client', tenant: 'consumers', loginHint: 'nana@msn.com', openExternal, base });
    assert.deepStrictEqual([t.accessToken, t.refreshToken, t.email, t.name], ['at-1', 'rt-1', 'nana@msn.com', 'Nana']);
    const r = await oauth.refresh({ clientId: 'test-client', tenant: 'consumers', refreshToken: 'rt-1', base });
    assert.deepStrictEqual([r.accessToken, r.refreshToken, refreshCount], ['at-2', 'rt-2', 1]);
    // Cancel path
    const p = oauth.authorize({ clientId: 'test-client', tenant: 'consumers', openExternal: () => {}, base });
    setTimeout(() => oauth.cancelPending(), 100);
    await assert.rejects(p, /cancelled/);
    await assert.rejects(oauth.authorize({ clientId: '', openExternal: () => {} }), /client ID in Settings/);
    console.log('Microsoft sign-in flow: all checks passed');
  } catch (e) {
    console.error('FAILED', e);
    process.exitCode = 1;
  }
  mock.close();
});
