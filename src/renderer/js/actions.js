'use strict';

(() => {
  const { h, api, fmt } = SS;
  const FREEMAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'zoho.com', 'comcast.net', 'att.net', 'verizon.net']);
  const sum = (list, k) => list.reduce((s, x) => s + (x[k] || 0), 0);
  const who = (name, address) => name || address;
  const emails = (n) => fmt.plural(n, 'email');

  async function refreshFreed() {
    try {
      SS.console.setFreed((await api('activity:list')).freed);
    } catch {
      /* ignore */
    }
  }

  function foundTable(folders) {
    const rows = folders.map((f) => h('div', null, h('span', null, f.name), h('span', { class: 'num' }, fmt.num(f.count)), h('span', { class: 'num muted' }, fmt.bytes(f.bytes))));
    if (folders.length > 1) rows.push(h('div', { class: 'total' }, h('span', null, 'Total'), h('span', { class: 'num' }, fmt.num(sum(folders, 'count'))), h('span', { class: 'num' }, fmt.bytes(sum(folders, 'bytes')))));
    return h('div', { class: 'foundlist' }, rows);
  }
  const loadingBody = (text) => h('div', { class: 'loading' }, SS.spinner(), h('span', null, text));

  function afterTrash(accountId, r, text) {
    SS.console.log(text, 'ok');
    if (r.undoable) SS.console.offerUndo(accountId);
  }

  async function trashMessages(accountId, folderId, msgs) {
    const ids = msgs.map((m) => m.id);
    const r = await SS.task(`Deleting ${emails(ids.length)}`, () => api('mail:trash', accountId, folderId, ids, sum(msgs, 'size')), { done: () => null });
    if (r.bytes != null) {
      SS.console.log(`Deleted ${emails(r.count)} forever and freed ${fmt.bytes(r.bytes)}`, 'ok');
      refreshFreed();
    } else afterTrash(accountId, r, `Moved ${emails(r.count)} to Trash`);
    SS.bus.emit('removed', { accountId, folderId, ids });
    return r;
  }

  async function destroyMessages(accountId, folderId, msgs, { skipConfirm = false } = {}) {
    const ids = msgs.map((m) => m.id);
    const bytes = sum(msgs, 'size');
    const n = ids.length;
    if (!skipConfirm) {
      const ok = await SS.confirm({
        title: n === 1 ? 'Delete this email forever?' : `Delete ${emails(n)} forever?`,
        body: [h('p', null, `This frees up ${fmt.bytes(bytes)}. ${n === 1 ? 'It won’t' : 'They won’t'} go to Trash, so ${n === 1 ? 'it' : 'they'} can’t be brought back.`)],
        confirm: 'Delete forever',
        danger: true,
      });
      if (!ok) return null;
    }
    const r = await SS.task(`Deleting ${emails(n)} forever`, () => api('mail:destroy', accountId, folderId, ids, bytes), {
      done: (r) => `Deleted ${emails(r.count)} forever and freed ${fmt.bytes(r.bytes)}`,
    });
    SS.bus.emit('removed', { accountId, folderId, ids });
    refreshFreed();
    return r;
  }

  async function junkMessages(accountId, folderId, msgs) {
    const ids = msgs.map((m) => m.id);
    const r = await SS.task('Moving to Spam', () => api('mail:junk', accountId, folderId, ids), { done: (r) => `Moved ${emails(r.count)} to Spam` });
    SS.bus.emit('removed', { accountId, folderId, ids });
    return r;
  }

  async function emptyFolder(accountId, folder) {
    const name = folder.special === 'junk' ? 'Spam' : 'Trash';
    const ok = await SS.confirm({
      title: `Empty ${name}?`,
      body: [h('p', null, `${folder.total ? `All ${emails(folder.total)} in ${name}` : `Everything in ${name}`} will be deleted forever. This frees up space and can’t be undone.`)],
      confirm: `Empty ${name}`,
      danger: true,
    });
    if (!ok) return null;
    const r = await SS.task(`Emptying ${name}`, () => api('mail:emptyFolder', accountId, folder.id, name), { done: (r) => `Emptied ${name}: ${emails(r.count)}, freed ${fmt.bytes(r.bytes)}` });
    SS.bus.emit('emptied', { accountId, folderId: folder.id });
    refreshFreed();
    return r;
  }

  function accountTable(accounts) {
    if (accounts.length === 1) return foundTable(accounts[0].folders);
    const rows = accounts.filter((a) => a.count).map((a) => h('div', null, h('span', null, a.email), h('span', { class: 'num' }, fmt.num(a.count)), h('span', { class: 'num muted' }, fmt.bytes(a.bytes))));
    rows.push(h('div', { class: 'total' }, h('span', null, 'Total'), h('span', { class: 'num' }, fmt.num(sum(accounts, 'count'))), h('span', { class: 'num' }, fmt.bytes(sum(accounts, 'bytes')))));
    return h('div', { class: 'foundlist' }, rows);
  }

  /**
   * targets: [{ accountId, value, mode, name }]. Any number of senders in any number of accounts,
   * searched together and confirmed once.
   */
  async function purgeSenders(targets, permanent = false) {
    const senders = [...new Map(targets.map((t) => [t.value, t])).values()];
    const lbl = senders.length === 1 ? (senders[0].mode === 'domain' ? `everyone at ${senders[0].value}` : who(senders[0].name, senders[0].value)) : fmt.plural(senders.length, 'sender');
    const m = SS.modal({
      title: permanent ? `Delete every email from ${lbl} forever?` : `Delete every email from ${lbl}?`,
      body: loadingBody('Looking through all your folders…'),
      actions: [{ label: 'Cancel', kind: 'ghost', value: null }],
    });
    let pre;
    try {
      pre = await api('sender:previewMany', targets.map((t) => ({ accountId: t.accountId, value: t.value, mode: t.mode || 'sender' })));
    } catch (e) {
      m.setBody(h('p', null, e.message));
      m.setActions([{ label: 'Close', kind: 'primary', autofocus: true }]);
      await m.result;
      return null;
    }
    if (!m.el.isConnected) return null;
    // Trash mode leaves what's already in Trash alone.
    const accounts = pre.accounts.map((a) => {
      const folders = permanent ? a.folders : a.folders.filter((f) => f.special !== 'trash');
      return { ...a, folders, count: sum(folders, 'count'), bytes: sum(folders, 'bytes') };
    });
    const count = sum(accounts, 'count');
    if (!count) {
      m.setTitle('Nothing to delete');
      m.setBody(h('p', null, pre.count ? `Every email from ${lbl} is already in Trash.` : `There are no emails from ${lbl}.`));
      m.setActions([{ label: 'OK', kind: 'primary', autofocus: true }]);
      await m.result;
      return null;
    }
    const names = senders.slice(0, 6).map((t) => who(t.name, t.value));
    m.setBody(
      h('p', null, `Found ${emails(count)} (${fmt.bytes(sum(accounts, 'bytes'))}) from ${lbl}${accounts.filter((a) => a.count).length > 1 ? ` in ${accounts.filter((a) => a.count).length} accounts` : ''}:`),
      senders.length > 1 ? h('p', { class: 'hint' }, names.join(', ') + (senders.length > names.length ? `, and ${senders.length - names.length} more` : '')) : null,
      accountTable(accounts),
      permanent ? SS.warning('These won’t go to Trash. Once deleted, they can’t be brought back.') : h('p', { class: 'hint' }, 'They’ll go to Trash, so you can get them back if you change your mind. Starred emails are always kept.')
    );
    m.setActions([
      { label: 'Cancel', kind: 'ghost', value: null },
      { label: permanent ? `Delete ${fmt.num(count)} forever` : `Delete ${emails(count)}`, kind: permanent ? 'danger' : 'primary', icon: permanent ? 'purge' : 'trash', run: () => api('sender:purgeMany', pre.token, permanent) },
    ]);
    const r = await m.result;
    if (!r) return null;
    if (permanent) {
      SS.console.log(`Deleted ${emails(r.count)} from ${lbl} forever and freed ${fmt.bytes(r.bytes)}`, 'ok');
      refreshFreed();
    } else {
      SS.console.log(`Moved ${emails(r.count)} from ${lbl} to Trash`, 'ok');
      SS.console.offerUndo(r.undoAccounts);
    }
    for (const t of targets) SS.bus.emit('purged', { accountId: t.accountId, value: t.value, mode: t.mode || 'sender', permanent });
    return r;
  }

  /** groups: [{ accountId, folderId, ids, bytes }] — explicit emails, possibly across accounts, one confirmation. */
  async function deleteGroups(groups, permanent, { confirm = permanent, title } = {}) {
    groups = groups.filter((g) => g.ids.length);
    const n = groups.reduce((s, g) => s + g.ids.length, 0);
    const bytes = sum(groups, 'bytes');
    if (!n) return null;
    if (confirm) {
      const ok = await SS.confirm({
        title: title || (permanent ? `Delete ${emails(n)} forever?` : `Delete ${emails(n)}?`),
        body: [h('p', null, permanent ? `This frees up ${fmt.bytes(bytes)}. They won’t go to Trash, so they can’t be brought back.` : `They’ll go to Trash (${fmt.bytes(bytes)}), so you can still get them back.`)],
        confirm: permanent ? 'Delete forever' : 'Delete',
        danger: permanent,
      });
      if (!ok) return null;
    }
    let count = 0;
    let freed = 0;
    const undo = new Set();
    await SS.task(permanent ? `Deleting ${emails(n)} forever` : `Deleting ${emails(n)}`, async () => {
      for (const g of groups) {
        const r = await api(permanent ? 'mail:destroy' : 'mail:trash', g.accountId, g.folderId, g.ids, g.bytes);
        count += r.count;
        freed += r.bytes || 0;
        if (r.undoable) undo.add(g.accountId);
        SS.bus.emit('removed', { accountId: g.accountId, folderId: g.folderId, ids: g.ids });
      }
    }, { done: () => (permanent ? `Deleted ${emails(count)} forever and freed ${fmt.bytes(freed)}` : `Moved ${emails(count)} to Trash`) });
    if (undo.size) SS.console.offerUndo([...undo]);
    if (permanent) refreshFreed();
    return { count, bytes: freed };
  }

  /** One sender (or domain) in one account. */
  function purgeSender(accountId, value, mode = 'sender', permanent = false, name = '') {
    return purgeSenders([{ accountId, value, mode, name }], permanent);
  }

  /**
   * Block dialog. address can be one address or a list; accountIds defaults to the current account.
   * Creates a blocked-sender rule in each account and (optionally) cleans up what's already there.
   */
  async function block(accountId, address, { name = '', mode: startMode = 'sender', accountIds = null } = {}) {
    const addresses = [].concat(address);
    const accts = accountIds && accountIds.length ? accountIds : [accountId];
    const single = addresses.length === 1;
    const domain = SS.domainOf(addresses[0]);
    let mode = single ? startMode : 'sender';
    let action = 'trash';
    let cleanup = true;
    let pre = null;
    let seq = 0;
    const countEl = h('span', { class: 'muted' }, '(counting…)');
    const domainWarn = h('div', { hidden: true }, SS.warning(`${domain} is used by millions of people. Blocking it would delete email from friends and family too.`));
    const targets = () => (mode === 'domain' ? [domain] : addresses);
    const showCount = () => {
      if (!pre) return;
      const list = pre.accounts.flatMap((a) => (action === 'permanent' ? a.folders : a.folders.filter((f) => f.special !== 'trash')));
      const n = sum(list, 'count');
      countEl.textContent = n ? `(${emails(n)}, ${fmt.bytes(sum(list, 'bytes'))})` : '(there aren’t any right now)';
    };
    const recount = async () => {
      const my = ++seq;
      pre = null;
      countEl.textContent = '(counting…)';
      domainWarn.hidden = !(mode === 'domain' && FREEMAIL.has(domain));
      try {
        const r = await api('sender:previewMany', accts.flatMap((a) => targets().map((v) => ({ accountId: a, value: v, mode }))));
        if (my === seq) {
          pre = r;
          showCount();
        }
      } catch {
        if (my === seq) countEl.textContent = '';
      }
    };
    const radio = (group, value, checked, title, sub, onChange) =>
      h('label', null, h('input', { type: 'radio', name: group, value, checked, onchange: () => onChange(value) }), h('span', null, h('b', null, title), sub ? h('small', null, sub) : null));
    const where = accts.length > 1 ? ` in all ${accts.length} accounts` : '';
    const m = SS.modal({
      title: single ? `Block ${who(name, addresses[0])}?` : `Block ${fmt.plural(addresses.length, 'sender')}?`,
      body: [
        single
          ? h(
              'div',
              { class: 'choice', role: 'radiogroup', 'aria-label': 'Who to block' },
              radio('mode', 'sender', mode === 'sender', 'Just this address', addresses[0], (v) => ((mode = v), recount())),
              radio('mode', 'domain', mode === 'domain', `Everyone from ${domain}`, 'Good for spam that keeps changing its address.', (v) => ((mode = v), recount()))
            )
          : h('p', { class: 'hint' }, addresses.slice(0, 8).join(', ') + (addresses.length > 8 ? `, and ${addresses.length - 8} more` : '')),
        domainWarn,
        h(
          'div',
          { class: 'choice', role: 'radiogroup', 'aria-label': 'What to do with their email' },
          radio('action', 'trash', true, 'Move their emails to Trash', 'Recommended. You can still get them back.', (v) => ((action = v), showCount())),
          radio('action', 'permanent', false, 'Delete their emails forever', 'Frees up space right away. Can’t be undone.', (v) => ((action = v), showCount()))
        ),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => (cleanup = e.target.checked) }), h('span', null, `Also delete the ones already here${where} `, countEl)),
        h('p', { class: 'hint' }, `Quiet Inbox removes their new emails while it’s running. It keeps running in the tray (by the clock) after you close the window, and checks every ${SS.state.settings.ruleIntervalMin || 15} minutes. Starred emails are always kept.`),
      ],
      actions: [
        { label: 'Cancel', kind: 'ghost', value: null },
        {
          label: 'Block',
          kind: 'primary',
          icon: 'junk',
          run: async () => {
            for (const a of accts) for (const v of targets()) await api('rules:create', a, { mode, value: v, action, cleanup: false });
            let cleaned = null;
            if (cleanup) {
              const fresh = pre || (await api('sender:previewMany', accts.flatMap((a) => targets().map((v) => ({ accountId: a, value: v, mode })))));
              cleaned = await api('sender:purgeMany', fresh.token, action === 'permanent');
            }
            return { cleaned };
          },
        },
      ],
    });
    recount();
    const r = await m.result;
    seq++;
    if (!r) return null;
    const lbl = !single ? fmt.plural(addresses.length, 'sender') : mode === 'domain' ? `everyone from ${domain}` : who(name, addresses[0]);
    const extra = r.cleaned?.count ? ` and deleted ${emails(r.cleaned.count)}` : '';
    SS.console.log(`Blocked ${lbl}${extra}`, 'ok');
    if (r.cleaned?.undoAccounts?.length) SS.console.offerUndo(r.cleaned.undoAccounts);
    for (const a of accts) {
      SS.bus.emit('rules-changed', { accountId: a });
      if (r.cleaned?.count) for (const v of targets()) SS.bus.emit('purged', { accountId: a, value: v, mode, permanent: action === 'permanent' });
    }
    if (r.cleaned?.count && action === 'permanent') refreshFreed();
    return r;
  }

  async function unsubscribe(accountId, folderId, msgId, sender, { accountIds = null } = {}) {
    const accts = accountIds && accountIds.length ? accountIds : [accountId];
    const name = who(sender.name, sender.address);
    const m = SS.modal({ title: `Unsubscribe from ${name}?`, body: loadingBody('Reading the email…'), actions: [{ label: 'Cancel', kind: 'ghost', value: null }] });
    let u;
    try {
      u = await api('unsub:get', accountId, folderId, msgId);
    } catch (e) {
      m.setBody(h('p', null, e.message));
      m.setActions([{ label: 'Close', kind: 'primary', autofocus: true }]);
      return m.result;
    }
    if (!m.el.isConnected) return null;
    if (!u) {
      m.setBody(h('p', null, 'This email doesn’t have an unsubscribe link. Blocking the sender will stop their emails instead.'));
      m.setActions([{ label: 'Close', kind: 'ghost', value: null }, { label: 'Block sender', kind: 'primary', value: 'block' }]);
      if ((await m.result) === 'block') return block(accountId, sender.address, { name: sender.name });
      return null;
    }
    const host = (url) => {
      try {
        return new URL(url).hostname;
      } catch {
        return url;
      }
    };
    const options = [];
    if (u.oneClick) options.push({ v: 'oneclick', t: 'Unsubscribe for me', s: 'Quiet Inbox sends the request. Nothing else opens.' });
    if (u.http) options.push({ v: 'browser', t: 'Open their unsubscribe page', s: `Opens ${host(u.http)} in your web browser.` });
    if (u.mailto) options.push({ v: 'mail', t: 'Send an unsubscribe email', s: 'Opens your mail program with the email ready to send.' });
    let method = options[0].v;
    let trashExisting = true;
    let addRule = false;
    m.setBody(
      h('p', { class: 'hint' }, 'Only unsubscribe from companies you know. For real spam, use Block instead, because unsubscribing tells spammers your address works.'),
      h('div', { class: 'choice' }, options.map((o, i) => h('label', null, h('input', { type: 'radio', name: 'unsub', checked: i === 0, onchange: () => (method = o.v) }), h('span', null, h('b', null, o.t), h('small', null, o.s))))),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => (trashExisting = e.target.checked) }), h('span', null, `Delete the emails I already have from ${name}`)),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (e) => (addRule = e.target.checked) }), h('span', null, 'Also block them, in case more arrive'))
    );
    m.setActions([
      { label: 'Cancel', kind: 'ghost', value: null },
      {
        label: 'Unsubscribe',
        kind: 'primary',
        icon: 'unsub',
        run: async () => {
          const res = await api('unsub:run', accountId, folderId, msgId, method, u);
          let moved = null;
          if (trashExisting) {
            const pre = await api('sender:previewMany', accts.map((a) => ({ accountId: a, value: sender.address, mode: 'sender' })));
            moved = await api('sender:purgeMany', pre.token, false);
          }
          if (addRule) for (const a of accts) await api('rules:create', a, { mode: 'sender', value: sender.address, action: 'trash', cleanup: false });
          return { res, moved, addRule };
        },
      },
    ]);
    const r = await m.result;
    if (!r) return null;
    const parts = [r.res.done ? `Unsubscribed from ${name}` : r.res.opened === 'browser' ? `Opened the unsubscribe page for ${name}` : `Opened an unsubscribe email to ${name}`];
    if (r.moved?.count) parts.push(`moved ${emails(r.moved.count)} to Trash`);
    if (r.addRule) parts.push('blocked them');
    SS.console.log(parts.join(', '), 'ok');
    if (r.moved?.undoAccounts?.length) SS.console.offerUndo(r.moved.undoAccounts);
    for (const a of accts) {
      if (r.moved?.count) SS.bus.emit('purged', { accountId: a, value: sender.address, mode: 'sender', permanent: false });
      if (r.addRule) SS.bus.emit('rules-changed', { accountId: a });
    }
    return r;
  }

  /** Sender-wide menu entries shared by Mail and Clean up. */
  function senderItems(accountId, address, { name = '', unsubscribe: unsub = null } = {}) {
    return [
      { heading: `From ${who(name, address)}` },
      { label: 'Delete every email from this sender', icon: 'trash', run: () => purgeSender(accountId, address, 'sender', false, name) },
      { label: 'Delete every email from this sender forever', icon: 'purge', danger: true, run: () => purgeSender(accountId, address, 'sender', true, name) },
      { label: 'Block this sender…', icon: 'junk', run: () => block(accountId, address, { name }) },
      unsub ? { label: 'Unsubscribe…', icon: 'unsub', run: unsub } : null,
      'sep',
      { label: 'Copy their email address', icon: 'copy', run: () => navigator.clipboard.writeText(address).then(() => SS.console.log(`Copied ${address}`)) },
    ].filter(Boolean);
  }

  /** Whole folder: every email except starred ones. */
  async function folderAction(accountId, folder, action) {
    const name = folder.special === 'junk' ? 'Spam' : folder.name;
    const permanent = action === 'destroy';
    const ok = await SS.confirm({
      title: permanent ? `Delete every email in ${name} forever?` : `Delete every email in ${name}?`,
      body: [
        h('p', null, `${folder.total ? `That’s up to ${emails(folder.total)}.` : ''} Starred emails are kept.`),
        permanent ? SS.warning('They won’t go to Trash, so they can’t be brought back.') : h('p', { class: 'hint' }, 'They’ll go to Trash, so you can get them back.'),
      ],
      confirm: permanent ? 'Delete forever' : 'Delete them all',
      danger: permanent,
    });
    if (!ok) return null;
    const r = await SS.task(`Deleting every email in ${name}`, () => api('mail:folderAction', accountId, folder.id, name, action), {
      done: (r) => (permanent ? `Deleted ${emails(r.count)} forever and freed ${fmt.bytes(r.bytes || 0)}` : `Moved ${emails(r.count)} to Trash`),
    });
    if (r.undoable) SS.console.offerUndo(accountId);
    if (permanent) refreshFreed();
    SS.bus.emit('emptied', { accountId, folderId: folder.id });
    return r;
  }

  SS.actions = { trashMessages, destroyMessages, junkMessages, emptyFolder, purgeSender, purgeSenders, deleteGroups, folderAction, block, unsubscribe, senderItems, refreshFreed };
})();
