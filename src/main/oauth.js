'use strict';

/**
 * "Sign in with Microsoft" for Outlook.com / Hotmail / Live / MSN (and Microsoft 365) mailboxes.
 * OAuth 2.0 authorization code + PKCE through the system browser with a loopback redirect, which is
 * what Microsoft requires for desktop apps. The token is used for IMAP (XOAUTH2), so the rest of the
 * app works the same as for any other provider.
 */
const http = require('http');
const crypto = require('crypto');
const { UserError } = require('./util');

const SCOPES = ['openid', 'email', 'profile', 'offline_access', 'https://outlook.office.com/IMAP.AccessAsUser.All'];
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function endpoints(tenant = 'consumers', base = 'https://login.microsoftonline.com') {
  return { authUrl: `${base}/${tenant}/oauth2/v2.0/authorize`, tokenUrl: `${base}/${tenant}/oauth2/v2.0/token` };
}

const PAGE = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:18px/1.5 "Segoe UI",system-ui,sans-serif;background:#F2F4F2;color:#16201B;display:grid;place-items:center;height:100vh;margin:0}
main{max-width:32rem;padding:2.2rem;border:1px solid #D9E0DB;border-radius:12px;background:#FBFCFB}h1{font-size:1.6rem;margin:0 0 .5rem}p{margin:0;color:#5C6B63}</style>
<main><h1>${title}</h1><p>${body}</p></main>`;

let pending = null;
function cancelPending() {
  if (pending) pending.cancel();
}

function decodeIdToken(t) {
  try {
    return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function describe(json, status) {
  const d = json?.error_description || json?.error || `HTTP ${status}`;
  if (/AADSTS700016/.test(d)) return 'Microsoft doesn’t recognize this app. Check the client ID in oauth.config.json.';
  if (/AADSTS7000218|client_assertion|client_secret/.test(d)) return 'In the app registration, turn on “Allow public client flows” (Authentication page).';
  if (/AADSTS50194|AADSTS9002331|AADSTS50020/.test(d)) return 'The app registration doesn’t allow this kind of account. Set “Supported account types” to include personal Microsoft accounts.';
  if (/AADSTS65004|AADSTS65001|consent/i.test(d)) return 'Microsoft needs you to choose Accept on the permissions page. Try again.';
  if (/invalid_grant|AADSTS700082|AADSTS70008/.test(d)) return 'Microsoft sign-in has expired. Sign in again.';
  return d.split(/\r?\n/)[0];
}

async function tokenRequest(cfg, params) {
  const body = new URLSearchParams({ client_id: cfg.clientId, scope: SCOPES.join(' '), ...params });
  const res = await fetch(cfg.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new UserError(describe(json, res.status));
  const claims = decodeIdToken(json.id_token);
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || null,
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
    email: String(claims.email || claims.preferred_username || '').toLowerCase(),
    name: claims.name || '',
  };
}

/** Builds the authorize URL and the PKCE/state values that go with it. */
function authRequest({ clientId, tenant, loginHint, redirectUri, base }) {
  const cfg = { clientId, ...endpoints(tenant, base) };
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: SCOPES.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  // With her address already known, go straight to the password page.
  if (loginHint) params.set('login_hint', loginHint);
  else params.set('prompt', 'select_account');
  return { cfg, url: `${cfg.authUrl}?${params}`, verifier, state };
}

async function redeem(req, code, redirectUri) {
  const t = await tokenRequest(req.cfg, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: req.verifier });
  if (!t.refreshToken) throw new UserError('Microsoft didn’t allow staying signed in. Try again.');
  return t;
}

/**
 * Sign-in inside an app window. openWindow(url, redirectUri) must resolve with the URL Microsoft
 * redirected to. Uses the exact "http://localhost" redirect URI that's registered.
 */
async function authorizeInWindow({ clientId, tenant, loginHint, openWindow, base }) {
  if (!clientId) throw new UserError('Microsoft sign-in isn’t set up yet. Add the client ID in Settings.');
  const redirectUri = 'http://localhost';
  const req = authRequest({ clientId, tenant, loginHint, redirectUri, base });
  const final = new URL(await openWindow(req.url, redirectUri));
  const err = final.searchParams.get('error');
  if (err) throw new UserError(err === 'access_denied' ? 'Sign-in was cancelled on the Microsoft page.' : describe({ error_description: final.searchParams.get('error_description') || err }));
  if (final.searchParams.get('state') !== req.state || !final.searchParams.get('code')) throw new UserError('Sign-in response didn’t match. Try again.');
  return redeem(req, final.searchParams.get('code'), redirectUri);
}

/**
 * Sign-in in the system browser with a loopback listener (fallback).
 * opts: { clientId, tenant, loginHint, openExternal, base? }  (base is only overridden in tests)
 */
async function authorize({ clientId, tenant, loginHint, openExternal, base }) {
  if (!clientId) throw new UserError('Microsoft sign-in isn’t set up yet. Add the client ID in Settings.');
  cancelPending();
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  // Browsers may resolve "localhost" to IPv6 first, so answer on ::1 too when it's available.
  const server6 = http.createServer((req, res) => server.emit('request', req, res));
  await new Promise((resolve) => {
    server6.once('error', resolve);
    server6.listen(port, '::1', resolve);
  });
  const closeAll = () => {
    server.close();
    if (server6.listening) server6.close();
  };
  // Entra matches a "http://localhost" registration on any port.
  const redirectUri = `http://localhost:${port}`;
  const req = authRequest({ clientId, tenant, loginHint, redirectUri, base });
  const { state } = req;

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new UserError('Sign-in took too long. Try again.')), 10 * 60 * 1000);
    function finish(err, value) {
      clearTimeout(timer);
      pending = null;
      setTimeout(closeAll, 500);
      err ? reject(err) : resolve(value);
    }
    pending = { cancel: () => finish(new UserError('Sign-in was cancelled.')) };
    server.on('request', (req, res) => {
      const u = new URL(req.url, redirectUri);
      if (u.pathname !== '/') return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      const err = u.searchParams.get('error');
      if (err) {
        res.end(PAGE('Sign-in didn’t finish', 'You can close this window and try again in Quiet Inbox.'));
        return finish(new UserError(err === 'access_denied' ? 'Sign-in was cancelled on the Microsoft page.' : describe({ error_description: u.searchParams.get('error_description') || err })));
      }
      if (u.searchParams.get('state') !== state || !u.searchParams.get('code')) {
        res.end(PAGE('Sign-in didn’t finish', 'You can close this window and try again in Quiet Inbox.'));
        return finish(new UserError('Sign-in response didn’t match. Try again.'));
      }
      res.end(PAGE('You’re signed in', 'You can close this window and go back to Quiet Inbox.'));
      finish(null, u.searchParams.get('code'));
    });
    Promise.resolve(openExternal(req.url)).catch((e) => finish(e));
  });
  return redeem(req, code, redirectUri);
}

async function refresh({ clientId, tenant, refreshToken, base }) {
  const t = await tokenRequest({ clientId, ...endpoints(tenant, base) }, { grant_type: 'refresh_token', refresh_token: refreshToken });
  if (!t.refreshToken) t.refreshToken = refreshToken;
  return t;
}

module.exports = { authorize, authorizeInWindow, refresh, cancelPending, SCOPES };
