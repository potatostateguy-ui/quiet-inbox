'use strict';

/**
 * Microsoft sign-in inside a Quiet Inbox window. When Microsoft redirects to the app's redirect URI,
 * the window catches it, hands back the URL (with the code) and closes itself, so there's no
 * browser to find and no "come back to the app" step.
 */
const { BrowserWindow, shell } = require('electron');
const { UserError } = require('./util');

let current = null;

function cancelSignInWindow() {
  if (current && !current.isDestroyed()) current.close();
}

function openSignInWindow(url, redirectUri, { parent = null, title = 'Sign in with Microsoft', partition = 'persist:microsoft-signin' } = {}) {
  cancelSignInWindow();
  return new Promise((resolve, reject) => {
    const w = new BrowserWindow({
      parent: parent && !parent.isDestroyed() && parent.isVisible() ? parent : undefined,
      modal: !!(parent && !parent.isDestroyed() && parent.isVisible()),
      width: 520,
      height: 720,
      minWidth: 420,
      minHeight: 560,
      title,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      // Its own cookie jar: Microsoft can remember her, which makes "Sign in again" a click or two.
      webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    current = w;
    w.setMenu(null);
    // Present as plain Chromium so Microsoft's pages treat it like a normal browser.
    w.webContents.setUserAgent(w.webContents.getUserAgent().replace(/\s(Electron|quiet-inbox|Quiet Inbox|QuietInbox)\/\S+/gi, ''));

    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (current === w) current = null;
      if (!w.isDestroyed()) w.destroy();
      err ? reject(err) : resolve(value);
    };
    const isRedirect = (u) => typeof u === 'string' && (u === redirectUri || u.startsWith(`${redirectUri}/`) || u.startsWith(`${redirectUri}?`));
    const urlOf = (e, u) => (e && typeof e.url === 'string' ? e.url : u);
    const intercept = (e, u) => {
      const target = urlOf(e, u);
      if (isRedirect(target)) {
        e.preventDefault();
        finish(null, target);
      }
    };
    w.webContents.on('will-redirect', intercept); // server redirect (302)
    w.webContents.on('will-navigate', intercept); // page-script redirect
    w.webContents.on('did-start-navigation', (e, u) => {
      const target = urlOf(e, u);
      if (isRedirect(target)) finish(null, target);
    });
    w.webContents.on('did-fail-load', (_e, code, desc, validatedURL, isMainFrame) => {
      if (!isMainFrame || settled) return;
      if (isRedirect(validatedURL)) return finish(null, validatedURL);
      if (code === -3) return; // aborted, e.g. our own interception
      finish(new UserError('Couldn’t reach Microsoft. Check the internet connection and try again.'));
    });
    // Links that try to open a new window (help pages and similar) go to the normal browser.
    w.webContents.setWindowOpenHandler(({ url: target }) => {
      if (/^https:\/\//i.test(target)) shell.openExternal(target);
      return { action: 'deny' };
    });
    w.on('closed', () => finish(new UserError('The sign-in window was closed before you finished.')));
    w.once('ready-to-show', () => {
      w.show();
      w.focus();
    });
    w.loadURL(url).catch(() => {}); // failures are reported through did-fail-load / interception
  });
}

module.exports = { openSignInWindow, cancelSignInWindow };
