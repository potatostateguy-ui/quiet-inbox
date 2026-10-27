'use strict';

(() => {
  const { h, api, fmt, icon } = SS;
  const TABS = [
    ['senders', 'Biggest senders'],
    ['never', 'Never opened'],
    ['lists', 'Newsletters'],
    ['largest', 'Biggest emails'],
    ['old', 'Old emails'],
  ];
  const NOTES = {
    senders: 'The people and companies using the most space.',
    never: 'Senders with at least 3 emails that you’ve almost never opened.',
    lists: 'Newsletters and mailing lists. Unsubscribing stops them at the source.',
    largest: 'Your biggest single emails, usually photos and attachments.',
    old: 'Emails you may no longer need. Starred emails are never included.',
  };
  // Folder kinds offered when several accounts are checked together: [special, name, plural]
  const KINDS = [
    ['inbox', 'Inbox', 'inboxes'],
    ['all', 'All Mail', 'All Mail folders'],
    ['junk', 'Spam', 'Spam folders'],
    ['trash', 'Trash', 'Trash folders'],
    ['archive', 'Archive', 'archives'],
    ['sent', 'Sent', 'Sent folders'],
  ];

  const s = { loading: false, folders: {}, accounts: [], pick: null, data: null, tab: 'senders', sort: 'bytes', filter: '', open: new Map(), checked: new Set(), checkedMsgs: new Set(), scan: null, loadedKey: null };
  let page;
  const multi = () => s.accounts.length > 1;
  const who = (x) => x.name || x.address;
  const emailOf = (id) => SS.state.accounts.find((a) => a.id === id)?.email || '';
  const fname = (f) => (f.special === 'junk' ? 'Spam' : f.name);
  const accountsKey = () => SS.state.accounts.map((a) => a.id).join(',');

  /** The folders being analysed: one folder, or the same kind of folder in each checked account. */
  function scopes() {
    if (!multi()) {
      const id = s.accounts[0];
      const f = (s.folders[id] || []).find((x) => x.id === s.pick);
      return f ? [{ accountId: id, folderId: f.id, folderName: fname(f), total: f.total }] : [];
    }
    return s.accounts
      .map((id) => {
        const f = (s.folders[id] || []).find((x) => x.special === s.pick);
        return f ? { accountId: id, folderId: f.id, folderName: fname(f), total: f.total } : null;
      })
      .filter(Boolean);
  }
  function where() {
    const sc = scopes();
    if (!multi() || sc.length < 2) return sc[0]?.folderName || 'this folder';
    return `your ${sc.length} ${(KINDS.find((k) => k[0] === s.pick) || [, , 'folders'])[2]}`;
  }
  // Which accounts a sender appeared in (from the merged scan).
  const accountsFor = (x) => [...new Set((x.xs || [0]).map((i) => s.data.scopes[i]?.accountId).filter(Boolean))];
  const clearSel = () => {
    s.checked.clear();
    s.checkedMsgs.clear();
  };

  function mount(el) {
    page = h('div', { class: 'page' });
    SS.replace(el, page);
    SS.bus.on('scan', (d) => {
      if (s.scan && d.accountId === s.scan.accountId && d.folderId === s.scan.folderId) {
        Object.assign(s.scan, { done: d.done, total: d.total });
        renderProgress();
      }
    });
    const refresh = (d) => {
      if (s.data && s.accounts.includes(d.accountId)) refreshSoon();
    };
    for (const evt of ['removed', 'purged', 'restored', 'emptied']) SS.bus.on(evt, refresh);
    SS.bus.on('account', () => SS.state.view === 'analytics' && s.loadedKey !== accountsKey() && load());
  }

  let refreshTimer = null;
  function refreshSoon() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      await reloadData();
      render();
    }, 150);
  }

  async function onShow() {
    if (s.loadedKey !== accountsKey()) await load();
  }

  async function load() {
    s.loadedKey = accountsKey();
    s.data = null;
    s.open.clear();
    clearSel();
    if (!SS.state.accounts.length) return render();
    s.loading = true;
    render();
    s.accounts = s.accounts.filter((id) => SS.state.accounts.some((a) => a.id === id));
    if (!s.accounts.length) s.accounts = SS.state.accounts.map((a) => a.id); // start with every account
    for (const a of SS.state.accounts) {
      if (!s.folders[a.id]) s.folders[a.id] = (await api('mail:folders', a.id).catch((e) => (SS.console.log(e.message, 'error'), []))).filter((f) => f.selectable);
    }
    fixPick();
    await reloadData();
    s.loading = false;
    render();
  }

  function fixPick() {
    if (multi()) {
      if (!KINDS.some((k) => k[0] === s.pick)) {
        const f = Object.values(s.folders).flat().find((x) => x.id === s.pick);
        s.pick = f && KINDS.some((k) => k[0] === f.special) ? f.special : 'inbox';
      }
    } else {
      const list = s.folders[s.accounts[0]] || [];
      if (!list.some((f) => f.id === s.pick)) {
        const prefer = KINDS.some((k) => k[0] === s.pick) ? s.pick : SS.account(s.accounts[0])?.isGmail ? 'all' : 'inbox';
        s.pick = (list.find((f) => f.special === prefer) || list.find((f) => f.special === 'inbox') || list[0])?.id || null;
      }
    }
  }

  async function reloadData() {
    const sc = scopes();
    s.data = sc.length ? await api('analytics:getMany', sc).catch(() => null) : null;
    s.open.clear();
    clearSel();
  }

  async function setAccounts(ids) {
    s.accounts = ids;
    fixPick();
    await reloadData();
    render();
  }

  async function scan() {
    const sc = scopes();
    for (let i = 0; i < sc.length; i++) {
      s.scan = { ...sc[i], i, n: sc.length, done: 0, total: sc[i].total || 0 };
      render();
      try {
        await SS.task(`Checking ${sc[i].folderName}${multi() ? ` in ${emailOf(sc[i].accountId)}` : ''}`, () => api('analytics:scan', sc[i].accountId, sc[i].folderId, sc[i].folderName), {
          done: (r) => `Checked ${fmt.plural(r.count, 'email')} in ${sc[i].folderName}${multi() ? ` (${emailOf(sc[i].accountId)})` : ''}`,
        });
      } catch {
        /* shown in the status bar; keep going with the other accounts */
      }
    }
    s.scan = null;
    await reloadData();
    render();
  }

  // ---------- render ----------

  function renderProgress() {
    const el = page.querySelector('.an-progress');
    if (!el || !s.scan) return;
    const pct = s.scan.total ? Math.min(100, (s.scan.done / s.scan.total) * 100) : 4;
    el.querySelector('i').style.width = `${pct}%`;
    const which = s.scan.n > 1 ? `${emailOf(s.scan.accountId)} (${s.scan.i + 1} of ${s.scan.n}): ` : '';
    el.querySelector('p').textContent = `${which}looked at ${fmt.num(s.scan.done)} of ${fmt.num(s.scan.total)} emails…`;
  }

  function render() {
    const inner = h('div', { class: 'page-inner' });
    SS.replace(page, inner);
    if (!SS.state.accounts.length) {
      inner.append(h('div', { class: 'empty' }, h('h3', null, 'Add your email first'), h('p', null, 'Once your email is connected, this page shows who’s filling up your mailbox.'), h('button', { class: 'btn primary lg', type: 'button', onclick: () => SS.addAccount() }, icon('plus'), 'Add your email account')));
      return;
    }
    if (s.loading) {
      inner.append(h('div', { class: 'page-head' }, h('h1', null, 'Clean up')), h('div', { class: 'empty' }, h('div', { class: 'loading', style: { 'justify-content': 'center' } }, SS.spinner(), 'Getting your folders…')));
      return;
    }
    const sc = scopes();
    const folderSel = multi()
      ? h('select', { class: 'select', 'aria-label': 'Folder to check', onchange: async (e) => ((s.pick = e.target.value), await reloadData(), render()) }, KINDS.filter((k) => s.accounts.some((id) => (s.folders[id] || []).some((f) => f.special === k[0]))).map(([v, label]) => h('option', { value: v, selected: v === s.pick }, label)))
      : h('select', { class: 'select', 'aria-label': 'Folder to check', onchange: async (e) => ((s.pick = e.target.value), await reloadData(), render()) }, (s.folders[s.accounts[0]] || []).map((f) => h('option', { value: f.id, selected: f.id === s.pick }, fname(f))));
    inner.append(
      h(
        'div',
        { class: 'page-head' },
        h('h1', null, 'Clean up'),
        folderSel,
        s.data ? h('span', { class: 'meta' }, `Checked ${fmt.ago(s.data.scannedAt)}`) : null,
        h('button', { class: `btn ${s.data && !s.data.missing ? '' : 'primary'}`, type: 'button', disabled: !!s.scan || !sc.length, onclick: scan }, icon('refresh'), s.data ? 'Check again' : `Check ${where()}`)
      )
    );
    if (SS.state.accounts.length > 1) inner.append(accountChips());
    if (multi() && sc.length < s.accounts.length) {
      const lacking = s.accounts.filter((id) => !sc.some((x) => x.accountId === id)).map(emailOf);
      inner.append(h('p', { class: 'hint', style: { margin: '-8px 0 16px' } }, `${lacking.join(', ')} ${lacking.length === 1 ? 'doesn’t' : 'don’t'} have this folder, so ${lacking.length === 1 ? 'it’s' : 'they’re'} left out.`));
    }
    if (s.scan) {
      inner.append(h('div', { class: 'an-progress' }, h('div', { class: 'bar' }, h('i', { style: { width: '3%' } })), h('p', null, 'Starting…')));
      renderProgress();
      if (!s.data) return;
    }
    if (!s.data) {
      inner.append(
        h(
          'div',
          { class: 'empty' },
          h('h3', null, 'See who’s filling up your mailbox'),
          h('p', null, `Quiet Inbox looks at every email in ${where()} and shows which senders take up the most space. Nothing is deleted until you choose.`),
          h('button', { class: 'btn primary lg', type: 'button', disabled: !sc.length, onclick: scan }, icon('search'), `Check ${where()}`)
        )
      );
      return;
    }
    if (s.data.missing) inner.append(h('p', { class: 'hint', style: { margin: '-8px 0 16px' } }, `${fmt.plural(s.data.missing, 'account')} ${s.data.missing === 1 ? 'hasn’t' : 'haven’t'} been checked yet. Choose Check again to include ${s.data.missing === 1 ? 'it' : 'them'}.`));
    const d = s.data;
    if (!d.totals.count) {
      inner.append(h('div', { class: 'empty' }, h('h3', null, `${where()[0].toUpperCase()}${where().slice(1)} ${multi() ? 'are' : 'is'} empty`), h('p', null, 'Pick another folder above to check it.')));
      return;
    }
    inner.append(hero(d), tabs(d), toolbar());
    const bar = bulk();
    if (bar) inner.append(bar);
    inner.append(body(d));
  }

  function accountChips() {
    const all = s.accounts.length === SS.state.accounts.length;
    return h(
      'div',
      { class: 'acct-chips', role: 'group', 'aria-label': 'Accounts to check', style: { margin: '-6px 0 20px' } },
      h('button', { class: 'acct-chip', type: 'button', 'aria-pressed': String(all), style: { 'padding-left': '14px' }, onclick: () => setAccounts(SS.state.accounts.map((a) => a.id)) }, all ? icon('check') : null, 'All accounts'),
      SS.state.accounts.map((a) => {
        const on = s.accounts.includes(a.id);
        return h(
          'button',
          {
            class: 'acct-chip',
            type: 'button',
            'aria-pressed': String(on),
            title: on && s.accounts.length === 1 ? 'At least one account stays selected' : '',
            onclick: () => {
              if (on && s.accounts.length === 1) return;
              setAccounts(on ? s.accounts.filter((id) => id !== a.id) : SS.state.accounts.map((x) => x.id).filter((id) => id === a.id || s.accounts.includes(id)));
            },
          },
          h('span', { class: SS.avatarClass(a.service) }, SS.initial('', a.email)),
          a.email,
          on ? icon('check') : null
        );
      })
    );
  }

  function hero(d) {
    const t = d.totals;
    const w = where();
    const headline =
      d.halfCount === 1
        ? `Half of the space in ${w} is used by one sender.`
        : d.halfCount && d.halfCount <= 25
          ? `Half of the space in ${w} is used by just ${d.halfCount} senders.`
          : `${w[0].toUpperCase()}${w.slice(1)} ${multi() ? 'have' : 'has'} ${fmt.plural(t.count, 'email')} from ${fmt.plural(d.senderCount, 'sender')}.`;
    const top = d.strip;
    const rest = Math.max(0, t.bytes - top.reduce((a, x) => a + x.bytes, 0));
    const seg = (i) => `var(--ramp-${i + 1})`;
    const jump = (x) => {
      s.tab = 'senders';
      s.sort = 'bytes';
      s.filter = x.address;
      clearSel();
      toggleOpen(x.address);
    };
    return h(
      'section',
      { class: 'an-hero' },
      h('p', { class: 'an-headline' }, headline),
      h(
        'div',
        { class: 'strip', role: 'img', 'aria-label': 'How the space is shared between the biggest senders' },
        top.map((x, i) => h('button', { type: 'button', style: { flex: `${x.bytes} 1 0`, '--seg': seg(i) }, title: `${who(x)}: ${fmt.bytes(x.bytes)} (${fmt.pct(x.bytes, t.bytes)})`, 'aria-label': `${who(x)}, ${fmt.bytes(x.bytes)}`, onclick: () => jump(x) })),
        rest ? h('span', { class: 'rest', style: { flex: `${rest} 1 0` }, title: `Everyone else: ${fmt.bytes(rest)}` }) : null
      ),
      h(
        'ul',
        { class: 'legend' },
        top.map((x, i) => h('li', null, h('button', { type: 'button', onclick: () => jump(x) }, h('i', { style: { '--seg': seg(i) } }), h('span', { class: 'lg-name' }, who(x)), h('span', { class: 'lg-size' }, fmt.bytes(x.bytes))))),
        rest ? h('li', null, h('button', { type: 'button', disabled: true }, h('i', { style: { '--seg': 'var(--rest)' } }), h('span', null, 'Everyone else'), h('span', { class: 'lg-size' }, fmt.bytes(rest)))) : null
      ),
      h(
        'dl',
        { class: 'stats' },
        h('div', { class: 'stat' }, h('dd', null, fmt.num(t.count)), h('dt', null, 'Emails')),
        h('div', { class: 'stat' }, h('dd', null, fmt.bytes(t.bytes)), h('dt', null, 'Space used')),
        h('div', { class: 'stat' }, h('dd', null, fmt.num(t.unread), h('small', null, fmt.pct(t.unread, t.count))), h('dt', null, 'Never opened')),
        h('div', { class: 'stat' }, h('dd', null, fmt.num(t.lists)), h('dt', null, 'From newsletters')),
        h('div', { class: 'stat freed' }, h('dd', null, d.freed ? fmt.bytes(d.freed) : 'None yet'), h('dt', null, 'Space freed so far'))
      )
    );
  }

  function tabs(d) {
    const n = { senders: d.senderCount, never: d.neverOpened.length, lists: d.lists.length, largest: null, old: null };
    return h(
      'div',
      { class: 'an-tabs', role: 'tablist' },
      TABS.map(([k, label]) =>
        h('button', { class: 'an-tab', role: 'tab', type: 'button', 'aria-selected': String(s.tab === k), onclick: () => ((s.tab = k), (s.filter = ''), clearSel(), s.open.clear(), render()) }, label, n[k] != null ? h('span', { class: 'n' }, fmt.num(n[k])) : null)
      )
    );
  }

  function toolbar() {
    const parts = [];
    if (['senders', 'never', 'lists'].includes(s.tab)) {
      const input = h('input', { class: 'input', type: 'search', placeholder: 'Find a sender', value: s.filter, 'aria-label': 'Find a sender' });
      input.addEventListener('input', () => {
        s.filter = input.value.trim().toLowerCase();
        clearSel();
        const t = page.querySelector('.table');
        if (t) t.replaceWith(body(s.data));
        const b = page.querySelector('.an-bulk');
        if (b) b.remove();
      });
      parts.push(h('div', { class: 'search' }, icon('search'), input));
      if (s.tab === 'senders') {
        parts.push(
          h(
            'div',
            { class: 'seg', role: 'group', 'aria-label': 'Sort by' },
            h('button', { type: 'button', 'aria-pressed': String(s.sort === 'bytes'), onclick: () => ((s.sort = 'bytes'), clearSel(), render()) }, 'Most space'),
            h('button', { type: 'button', 'aria-pressed': String(s.sort === 'count'), onclick: () => ((s.sort = 'count'), clearSel(), render()) }, 'Most emails')
          )
        );
      }
    }
    parts.push(h('span', { class: 'note' }, NOTES[s.tab]));
    return h('div', { class: 'an-toolbar' }, parts);
  }

  function senderList(d) {
    let list = s.tab === 'never' ? d.neverOpened : s.tab === 'lists' ? d.lists : s.sort === 'count' ? d.sendersByCount : d.sendersBySize;
    if (s.filter) list = list.filter((x) => x.address.includes(s.filter) || (x.name || '').toLowerCase().includes(s.filter));
    return list;
  }

  const targetsFor = (list) => list.flatMap((x) => accountsFor(x).map((accountId) => ({ accountId, value: x.address, mode: 'sender', name: x.name })));

  /** One bar for everything selected on this tab; every action behind it asks once. */
  function bulk() {
    if (s.tab === 'largest' && s.checkedMsgs.size) {
      const recs = s.data.largest.filter((r) => s.checkedMsgs.has(`${r.x}:${r.i}`));
      return h(
        'div',
        { class: 'an-bulk' },
        h('strong', null, `${fmt.plural(recs.length, 'email')} selected`),
        h('button', { class: 'btn sm', type: 'button', onclick: () => SS.actions.deleteGroups(groupsOf(recs), false, { confirm: true }).catch(() => {}) }, icon('trash'), 'Delete'),
        h('button', { class: 'btn sm danger-ghost', type: 'button', onclick: () => SS.actions.deleteGroups(groupsOf(recs), true).catch(() => {}) }, icon('purge'), 'Delete forever'),
        h('button', { class: 'btn sm ghost', type: 'button', onclick: () => (clearSel(), render()) }, 'Clear')
      );
    }
    if (!s.checked.size || !['senders', 'never', 'lists'].includes(s.tab)) return null;
    const chosen = senderList(s.data).filter((x) => s.checked.has(x.address));
    const accts = [...new Set(chosen.flatMap(accountsFor))];
    return h(
      'div',
      { class: 'an-bulk' },
      h('strong', null, `${fmt.plural(chosen.length, 'sender')} selected`),
      h('button', { class: 'btn sm', type: 'button', onclick: () => SS.actions.purgeSenders(targetsFor(chosen), false).catch(() => {}) }, icon('trash'), 'Delete all their emails'),
      h('button', { class: 'btn sm danger-ghost', type: 'button', onclick: () => SS.actions.purgeSenders(targetsFor(chosen), true).catch(() => {}) }, icon('purge'), 'Delete forever'),
      h('button', { class: 'btn sm ghost', type: 'button', onclick: () => SS.actions.block(accts[0], chosen.map((x) => x.address), { accountIds: accts }).catch(() => {}) }, icon('junk'), 'Block them'),
      h('button', { class: 'btn sm ghost', type: 'button', onclick: () => (clearSel(), render()) }, 'Clear')
    );
  }

  function groupsOf(records) {
    const by = new Map();
    for (const r of records) {
      const sc = s.data.scopes[r.x || 0];
      if (!sc) continue;
      if (!by.has(r.x)) by.set(r.x, { accountId: sc.accountId, folderId: sc.folderId, ids: [], bytes: 0 });
      const g = by.get(r.x);
      g.ids.push(r.i);
      g.bytes += r.z;
    }
    return [...by.values()];
  }

  function body(d) {
    if (s.tab === 'largest') return largest(d);
    if (s.tab === 'old') return old(d);
    const list = senderList(d);
    if (!list.length) return h('div', { class: 'table' }, h('div', { class: 'empty' }, h('p', null, s.filter ? 'No sender matches that.' : s.tab === 'never' ? 'You open nearly everything you get. Nice.' : 'No newsletters found.')));
    const max = Math.max(...list.map((x) => x.bytes), 1);
    const all = h('input', { type: 'checkbox', 'aria-label': 'Select every sender in this list', title: 'Select all', checked: list.every((x) => s.checked.has(x.address)) });
    all.indeterminate = s.checked.size > 0 && !all.checked;
    all.addEventListener('change', () => {
      if (all.checked) list.forEach((x) => s.checked.add(x.address));
      else s.checked.clear();
      render();
    });
    return h(
      'div',
      { class: 'table' },
      h('div', { class: 'trow thead cols-senders' }, all, h('span'), h('span', null, s.checked.size ? `${fmt.num(s.checked.size)} of ${fmt.num(list.length)} selected` : 'Sender'), h('span', { class: 'num' }, 'Emails'), h('span', null, 'Space'), h('span', null, 'Last email'), h('span')),
      list.map((x) => senderRow(x, max))
    );
  }

  function senderRow(x, max) {
    const isOpen = s.open.has(x.address);
    const accts = accountsFor(x);
    const more = h('button', { class: 'icon-btn', type: 'button', 'aria-label': `More for ${who(x)}`, 'aria-haspopup': 'menu' }, icon('more'));
    const listScope = s.data.scopes[x.latestListX || 0];
    const unsub = x.latestListId && listScope ? () => SS.actions.unsubscribe(listScope.accountId, listScope.folderId, x.latestListId, { name: x.name, address: x.address }, { accountIds: accts }) : null;
    more.addEventListener('click', () =>
      SS.menu(more, [
        { heading: `From ${who(x)}` },
        unsub ? { label: 'Unsubscribe…', icon: 'unsub', run: () => unsub().catch(() => {}) } : null,
        { label: 'Copy their email address', icon: 'copy', run: () => navigator.clipboard.writeText(x.address).then(() => SS.console.log(`Copied ${x.address}`)) },
      ].filter(Boolean))
    );
    const sub = multi() ? (accts.length > 1 ? `${x.name ? `${x.address} · ` : ''}in ${accts.length} accounts` : `${x.name ? `${x.address} · ` : ''}${emailOf(accts[0])}`) : x.name ? x.address : null;
    const wrap = h(
      'div',
      null,
      h(
        'div',
        { class: 'trow sender-row cols-senders' },
        h('input', { type: 'checkbox', checked: s.checked.has(x.address), 'aria-label': `Select ${who(x)}`, onchange: (e) => (e.target.checked ? s.checked.add(x.address) : s.checked.delete(x.address), render()) }),
        h('button', { class: 'chev', type: 'button', 'aria-expanded': String(isOpen), 'aria-label': `Show emails from ${who(x)}`, onclick: () => toggleOpen(x.address) }, icon('chevron')),
        h('div', { class: 'who' }, h('b', null, who(x)), sub ? h('span', null, sub) : null),
        h('span', { class: 'num' }, fmt.num(x.count)),
        h('div', { class: 'sizecell' }, h('div', { class: 'bar' }, h('i', { style: { width: `${Math.max(2, (x.bytes / max) * 100)}%` } })), h('span', null, fmt.bytes(x.bytes))),
        h('span', { class: 'muted' }, fmt.date(x.last)),
        h(
          'div',
          { class: 'acts' },
          s.tab === 'lists' && unsub ? h('button', { class: 'btn ghost', type: 'button', onclick: () => unsub().catch(() => {}) }, icon('unsub'), 'Unsubscribe') : null,
          h('button', { class: 'btn ghost', type: 'button', onclick: () => SS.actions.purgeSenders(targetsFor([x]), false).catch(() => {}) }, icon('trash'), 'Delete all'),
          h('button', { class: 'btn danger-ghost', type: 'button', title: 'Delete every email from this sender forever', onclick: () => SS.actions.purgeSenders(targetsFor([x]), true).catch(() => {}) }, icon('purge'), 'Forever'),
          s.tab === 'lists' && unsub ? null : h('button', { class: 'btn ghost', type: 'button', onclick: () => SS.actions.block(accts[0], x.address, { name: x.name, accountIds: accts }).catch(() => {}) }, icon('junk'), 'Block'),
          more
        )
      )
    );
    if (isOpen) wrap.append(expansion(x));
    return wrap;
  }

  async function toggleOpen(address) {
    if (s.open.has(address) && s.open.get(address)?.list) s.open.delete(address);
    else {
      s.open.set(address, { list: null, checked: new Set(), limit: 100 });
      render();
      const list = await api('analytics:detailMany', s.data.scopes, address).catch(() => []);
      const o = s.open.get(address);
      if (o) o.list = list;
    }
    render();
  }

  function expansion(x) {
    const o = s.open.get(x.address);
    if (!o || !o.list) return h('div', { class: 'texpand' }, h('div', { class: 'loading' }, SS.spinner(), 'Loading their emails…'));
    const key = (r) => `${r.x}:${r.i}`;
    const sel = o.list.filter((r) => o.checked.has(key(r)));
    const all = h('input', { type: 'checkbox', 'aria-label': 'Select all their emails', checked: o.checked.size === o.list.length && o.list.length > 0 });
    all.indeterminate = o.checked.size > 0 && !all.checked;
    all.addEventListener('change', () => {
      o.checked = all.checked ? new Set(o.list.map(key)) : new Set();
      render();
    });
    const inWhat = multi() ? where() : s.data.scopes[0]?.folderName;
    return h(
      'div',
      { class: 'texpand' },
      h(
        'div',
        { class: 'texpand-head' },
        all,
        h('span', { class: 'muted' }, o.checked.size ? `${fmt.num(o.checked.size)} selected` : `Select all ${fmt.plural(o.list.length, 'email')} in ${inWhat}`),
        h('button', { class: 'btn sm', type: 'button', disabled: !sel.length, onclick: () => SS.actions.deleteGroups(groupsOf(sel), false).catch(() => {}) }, icon('trash'), 'Delete selected'),
        h('button', { class: 'btn sm danger-ghost', type: 'button', disabled: !sel.length, onclick: () => SS.actions.deleteGroups(groupsOf(sel), true).catch(() => {}) }, icon('purge'), 'Delete selected forever')
      ),
      o.list.slice(0, o.limit).map((r) =>
        h(
          'label',
          { class: `mini ${r.r ? '' : 'unread'}` },
          h('input', { type: 'checkbox', checked: o.checked.has(key(r)), onchange: (e) => (e.target.checked ? o.checked.add(key(r)) : o.checked.delete(key(r)), render()) }),
          h('span', { class: 'sub' }, r.p ? h('span', { class: 'star', title: 'Starred' }, icon('star')) : null, r.s || '(no subject)', multi() ? h('span', { class: 'where-tag' }, emailOf(s.data.scopes[r.x]?.accountId)) : null),
          h('span', { class: 'muted' }, fmt.date(r.d)),
          h('span', { class: 'num' }, fmt.bytes(r.z))
        )
      ),
      o.list.length > o.limit ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => ((o.limit += 200), render()) }, `Show more (${fmt.num(o.list.length - o.limit)} left)`) : null
    );
  }

  function largest(d) {
    const key = (r) => `${r.x}:${r.i}`;
    const all = h('input', { type: 'checkbox', 'aria-label': 'Select every email in this list', checked: d.largest.length > 0 && d.largest.every((r) => s.checkedMsgs.has(key(r))) });
    all.indeterminate = s.checkedMsgs.size > 0 && !all.checked;
    all.addEventListener('change', () => {
      if (all.checked) d.largest.forEach((r) => s.checkedMsgs.add(key(r)));
      else s.checkedMsgs.clear();
      render();
    });
    return h(
      'div',
      { class: 'table' },
      h('div', { class: 'trow thead cols-largest' }, all, h('span', null, s.checkedMsgs.size ? `${fmt.num(s.checkedMsgs.size)} selected` : 'Email'), h('span', null, 'From'), h('span', null, 'Date'), h('span', { class: 'num' }, 'Size'), h('span')),
      d.largest.map((r) =>
        h(
          'div',
          { class: 'trow sender-row cols-largest' },
          h('input', { type: 'checkbox', 'aria-label': `Select ${r.s || 'email'}`, checked: s.checkedMsgs.has(key(r)), onchange: (e) => (e.target.checked ? s.checkedMsgs.add(key(r)) : s.checkedMsgs.delete(key(r)), render()) }),
          h('div', { class: 'who' }, h('b', null, r.p ? h('span', { class: 'mini' }, h('span', { class: 'star', title: 'Starred' }, icon('star'))) : null, r.s || '(no subject)'), h('span', null, [r.a ? 'Has attachments' : '', multi() ? emailOf(s.data.scopes[r.x]?.accountId) : ''].filter(Boolean).join(' · ') || null)),
          h('div', { class: 'who' }, h('span', null, r.n || r.f)),
          h('span', { class: 'muted' }, fmt.date(r.d)),
          h('span', { class: 'num' }, h('b', null, fmt.bytes(r.z))),
          h(
            'div',
            { class: 'acts' },
            h('button', { class: 'btn ghost', type: 'button', onclick: () => SS.actions.deleteGroups(groupsOf([r]), false).catch(() => {}) }, icon('trash'), 'Delete'),
            h('button', { class: 'btn danger-ghost', type: 'button', onclick: () => SS.actions.deleteGroups(groupsOf([r]), true).catch(() => {}) }, icon('purge'), 'Forever')
          )
        )
      )
    );
  }

  function old(d) {
    const a = d.ages;
    const tiers = [
      { label: 'Older than 1 year', days: 365, b: a.slice(3) },
      { label: 'Older than 2 years', days: 730, b: a.slice(4) },
      { label: 'Older than 5 years', days: 1826, b: a.slice(5) },
    ].map((t) => ({ ...t, count: t.b.reduce((x, y) => x + y.count, 0), bytes: t.b.reduce((x, y) => x + y.bytes, 0) }));
    const act = async (t, permanent) => {
      const groups = await api('analytics:olderMany', s.data.scopes, t.days);
      const n = groups.reduce((x, g) => x + g.ids.length, 0);
      return SS.actions
        .deleteGroups(groups, permanent, { confirm: true, title: permanent ? `Delete ${fmt.plural(n, 'email')} ${t.label.toLowerCase()} forever?` : `Delete ${fmt.plural(n, 'email')} ${t.label.toLowerCase()}?` })
        .catch(() => {});
    };
    const months = d.months;
    const maxM = Math.max(...months.map((m) => m.count), 1);
    const mLabel = (k) => new Date(`${k}-15`).toLocaleDateString([], { month: 'short', year: 'numeric' });
    return h(
      'div',
      null,
      h(
        'div',
        { class: 'table', style: { 'margin-bottom': '24px' } },
        tiers.map((t) =>
          h(
            'div',
            { class: 'old-row' },
            h('b', null, t.label),
            h('span', { class: 'num' }, fmt.plural(t.count, 'email')),
            h('span', { class: 'num muted' }, fmt.bytes(t.bytes)),
            h(
              'div',
              { class: 'acts' },
              h('button', { class: 'btn ghost', type: 'button', disabled: !t.count, onclick: () => act(t, false) }, icon('trash'), 'Delete these'),
              h('button', { class: 'btn danger-ghost', type: 'button', disabled: !t.count, onclick: () => act(t, true) }, icon('purge'), 'Forever')
            )
          )
        )
      ),
      h(
        'div',
        { class: 'chart' },
        h('h3', null, 'Emails received each month'),
        h('p', { class: 'sub' }, 'The last two years. A tall bar means a busy month.'),
        h('div', { class: 'cols' }, months.map((m) => h('div', { style: { height: `${(m.count / maxM) * 100}%` }, title: `${mLabel(m.key)}: ${fmt.plural(m.count, 'email')}, ${fmt.bytes(m.bytes)}` }))),
        h('div', { class: 'cols-axis' }, h('span', null, mLabel(months[0].key)), h('span', null, mLabel(months[months.length - 1].key)))
      )
    );
  }

  SS.Cleanup = { mount, onShow };
})();
