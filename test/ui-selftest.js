'use strict';
// Drives the real UI and saves screenshots. Used only when QUIET_INBOX_SELFTEST is set.
const fs = require('fs');
const path = require('path');

module.exports.run = (win) => {
  const out = process.env.QUIET_INBOX_SELFTEST;
  const mode = process.env.QUIET_INBOX_SELFTEST_MODE || 'full';
  const logs = [];
  win.webContents.on('console-message', (e) => logs.push(`[${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`));
  const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`, true);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => fs.writeFileSync(path.join(out, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const until = async (cond, ms = 15000) => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      if (await js(`return !!(${cond})`)) return true;
      await wait(200);
    }
    logs.push(`TIMEOUT waiting for ${cond}`);
    return false;
  };
  win.webContents.once('did-finish-load', async () => {
    try {
      await wait(1500);
      if (mode === 'mswindow') {
        // Mock Microsoft login at QUIET_INBOX_MS_BASE (must be http://127.0.0.1:18765).
        const http = require('http');
        const { BrowserWindow } = require('electron');
        const stats = { authorize: 0, token: 0, uaHasElectron: null, style: 'post' };
        const mock = http.createServer(async (req, res) => {
          const u = new URL(req.url, 'http://127.0.0.1');
          if (u.pathname.endsWith('/authorize')) {
            stats.authorize++;
            stats.uaHasElectron = /Electron/i.test(req.headers['user-agent'] || '');
            stats.hint = u.searchParams.get('login_hint');
            stats.redirect = u.searchParams.get('redirect_uri');
            const back = `${u.searchParams.get('redirect_uri')}/?code=abc123&state=${u.searchParams.get('state')}`;
            const go = stats.style === 'post'
              ? `document.forms[0].submit()`
              : `location.href=${JSON.stringify(back)}`;
            res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html><title>Sign in to your account</title><body style="font:16px Segoe UI,sans-serif;padding:40px"><h2>Microsoft</h2><p>${stats.hint}</p><form method="post" action="/login?back=${encodeURIComponent(back)}"><input type="password" value="secret" style="width:100%;padding:8px"><button>Sign in</button></form><script>setTimeout(()=>{${go}},1800)</script>`);
            return;
          }
          if (u.pathname === '/login') {
            res.writeHead(302, { Location: u.searchParams.get('back') }).end();
            return;
          }
          if (u.pathname.endsWith('/token')) {
            stats.token++;
            const id = `x.${Buffer.from(JSON.stringify({ preferred_username: 'nana@msn.com', name: 'Nana' })).toString('base64url')}.y`;
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: id }));
            return;
          }
          res.writeHead(404).end();
        });
        await new Promise((r) => mock.listen(18765, '127.0.0.1', r));
        await js(`document.querySelector('.welcome .btn.primary').click()`);
        await wait(300);
        await js(`const i=document.querySelector('.modal input'); i.value='nana@msn.com'; document.querySelector('.modal-foot .btn.primary').click()`);
        await until(`document.querySelector('.modal h2') && document.querySelector('.modal h2').textContent.includes('Turn on')`);
        await shot('50-ms-setup');
        await js(`document.querySelector('.modal input').value='11111111-2222-3333-4444-555555555555'; document.querySelector('.modal-foot .btn.primary').click()`);
        await wait(1200);
        const signin = BrowserWindow.getAllWindows().find((w) => w !== win);
        logs.push('sign-in window opened: ' + !!signin);
        await shot('51-ms-waiting');
        if (signin) fs.writeFileSync(path.join(out, '52-ms-window.png'), (await signin.webContents.capturePage()).toPNG());
        await until(`document.querySelector('.signin-status .modal-error')`, 20000);
        logs.push(`server-redirect style: authorize=${stats.authorize} token=${stats.token} hint=${stats.hint} redirect=${stats.redirect} uaHasElectron=${stats.uaHasElectron}`);
        logs.push('window closed itself: ' + (BrowserWindow.getAllWindows().length === 1));
        logs.push('modal shows: ' + (await js(`return document.querySelector('.signin-status').innerText.replace(/\\s+/g,' ')`)));
        await shot('53-ms-after');
        stats.style = 'script';
        await js(`[...document.querySelectorAll('.signin-status .btn')].find(b=>b.textContent.includes('Try again')).click()`);
        await until(`document.querySelector('.signin-status .modal-error')`, 20000);
        logs.push(`script-redirect style: authorize=${stats.authorize} token=${stats.token}; windows open=${BrowserWindow.getAllWindows().length}`);
        mock.close();
      } else if (mode === 'welcome') {
        await shot('01-welcome');
        await js(`document.querySelector('.welcome .btn.primary').click()`);
        await wait(300);
        await js(`const i=document.querySelector('.modal input'); i.value='grandma@gmail.com'; document.querySelector('.modal-foot .btn.primary').click()`);
        await until(`document.querySelector('.signin-steps')`);
        await wait(300);
        await shot('02-signin-gmail');
        await js(`document.querySelector('.modal-foot .btn.ghost').click()`);
        await wait(300);
        await js(`const i=document.querySelector('.modal input'); i.value='nana@msn.com'; document.querySelector('.modal-foot .btn.primary').click()`);
        await wait(1200);
        await shot('03-signin-msn');
      } else {
        await until(`document.querySelectorAll('.msg').length > 5`);
        // star a BigRetail newsletter so we can check bulk deletes keep it
        await js(`const i=document.querySelector('.list-head input[type=search]'); i.value='Flash sale'; i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}))`);
        await until(`document.querySelectorAll('.msg').length > 3 && document.querySelector('.list-title .meta').textContent.includes('match')`);
        await js(`document.querySelector('.msg .msg-star').click()`);
        await until(`document.querySelector('.msg .msg-star.on')`);
        await js(`document.querySelectorAll('.msg')[0].click()`);
        await until(`document.querySelector('.reader-body iframe')`);
        await wait(500);
        await shot('10-mail-star');
        await js(`const i=document.querySelector('.list-head input[type=search]'); i.value=''; i.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
        await until(`document.querySelectorAll('.msg').length > 40`);
        // select all in folder
        await js(`document.querySelector('.select-all input').click()`);
        await wait(300);
        logs.push('select-all-in-folder link: ' + (await js(`return [...document.querySelectorAll('.bulkbar .link')].map(b=>b.textContent).join('|')`)));
        await js(`document.querySelector('.bulkbar .link').click()`);
        await wait(300);
        await shot('11-select-all-folder');
        await js(`[...document.querySelectorAll('.bulkbar .btn')].find(b=>b.textContent==='Clear').click()`);
        // confirmation must survive a click outside it
        await js(`document.querySelectorAll('.msg .msg-more')[1].click()`);
        await wait(200);
        await js(`[...document.querySelectorAll('.menu button')].find(b=>b.textContent.includes('forever')).click()`);
        await wait(300);
        await js(`const o=document.querySelector('.overlay'); for (const t of ['mousedown','mouseup','click']) o.dispatchEvent(new MouseEvent(t,{bubbles:true,clientX:5,clientY:5}))`);
        await wait(300);
        logs.push('dialog still open after outside click: ' + (await js(`return !!document.querySelector('.overlay .modal')`)));
        await shot('12-dialog-stays');
        await js(`document.querySelector('.modal-foot .btn.ghost').click()`);
        // Clean up across both accounts
        await js(`document.querySelector('.tab[data-view=analytics]').click()`);
        await until(`document.querySelector('.acct-chips')`);
        await js(`[...document.querySelectorAll('.page-head .btn')].find(b=>/Check/.test(b.textContent)).click()`);
        await until(`document.querySelector('.an-hero') && !document.querySelector('.an-progress')`, 60000);
        await wait(400);
        await shot('20-cleanup-two-accounts');
        // select all senders, then one confirmation for the lot
        await js(`document.querySelector('.thead input[type=checkbox]').click()`);
        await wait(300);
        await shot('21-select-all-senders');
        await js(`[...document.querySelectorAll('.an-bulk .btn')].find(b=>b.textContent.includes('Delete all')).click()`);
        await until(`document.querySelector('.foundlist')`, 30000);
        await wait(300);
        await shot('22-one-confirmation');
        logs.push('confirmation dialogs open: ' + (await js(`return document.querySelectorAll('.modal').length`)));
        await js(`document.querySelector('.modal-foot .btn.ghost').click()`);
        await wait(300);
        logs.push('after cancel, selection kept: ' + (await js(`return !!document.querySelector('.an-bulk')`)));
        await js(`[...document.querySelectorAll('.an-bulk .btn')].find(b=>b.textContent.trim()==='Clear').click()`);
        await wait(300);
        // delete two BigRetail senders forever across both accounts in one go
        await js(`for (const r of document.querySelectorAll('.sender-row')) if (/bigretail/.test(r.textContent)) r.querySelector('input[type=checkbox]').click()`);
        await wait(300);
        await js(`[...document.querySelectorAll('.an-bulk .btn')].find(b=>b.textContent.includes('forever')).click()`);
        await until(`document.querySelector('.modal-foot .btn.danger')`, 30000);
        logs.push('bigretail confirm: ' + (await js(`return document.querySelector('.modal .modal-body').innerText.replace(/\s+/g,' ').slice(0,200)`)));
        await js(`document.querySelector('.modal-foot .btn.danger').click()`);
        await until(`!document.querySelector('.overlay')`, 30000);
        await wait(1200);
        logs.push('starred newsletter kept: ' + (await js(`return (await SS.api('mail:list','acct-1','INBOX',{query:'Flash sale'})).items.length`)));
        logs.push('bigretail left in account 2: ' + (await js(`return (await SS.api('sender:previewMany',[{accountId:'acct-2',value:'bigretail.com',mode:'domain'}])).count`)));
        await shot('23-after-bulk');
        await js(`[...document.querySelectorAll('.an-tab')][3].click()`);
        await wait(300);
        await js(`document.querySelector('.thead input[type=checkbox]').click()`);
        await wait(300);
        await shot('24-largest-select-all');
        await js(`document.querySelector('.tab[data-view=settings]').click()`);
        await wait(800);
        await js(`document.querySelector('.view:not([hidden]) .page').scrollTop = 600`);
        await wait(300);
        await shot('40-settings');
      }
    } catch (e) {
      logs.push(`SELFTEST ERROR ${e.stack}`);
    }
    fs.writeFileSync(path.join(out, `console-${mode}.log`), logs.join('\n'));
    require('electron').app.exit(0);
  });
};
