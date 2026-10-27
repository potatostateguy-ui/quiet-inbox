'use strict';

(() => {
  const { h, api, fmt, icon } = SS;
  const MAIN = ['inbox', 'flagged', 'junk', 'trash', 'sent', 'archive', 'all', 'drafts'];
  const BIG = 1024 * 1024;

  const s = { allInFolder: false, folders: [], folderId: null, items: [], next: null, total: null, query: '', checked: new Set(), anchor: null, openId: null, message: null, showPics: false, showHeaders: false, loading: false, error: null, token: 0, openToken: 0 };
  const rows = new Map();
  let root, sidebar, listPane, reader, listEl, foot, observer;

  const acct = () => SS.state.accountId;
  const folder = () => s.folders.find((f) => f.id === s.folderId) || null;
  const selected = () => s.items.filter((m) => s.checked.has(m.id));
  const fromName = (m) => m.from.name || m.from.address || '(no sender)';

  function mount(el) {
    root = el;
    sidebar = h('aside', { class: 'sidebar', 'aria-label': 'Accounts and folders' });
    listPane = h('section', { class: 'list-pane', 'aria-label': 'Emails' });
    reader = h('section', { class: 'reader', 'aria-label': 'Reading pane' });
    observer = new IntersectionObserver((e) => {
      if (e[0].isIntersecting && s.next && !s.loading) loadList({ reset: false });
    });
    document.addEventListener('keydown', onKey);
    SS.bus.on('account', () => setAccount());
    SS.bus.on('removed', ({ accountId, folderId, ids }) => {
      if (accountId !== acct()) return;
      if (folderId === s.folderId) dropItems(new Set(ids.map(String)));
      refreshFoldersSoon();
    });
    SS.bus.on('purged', ({ accountId, value, mode }) => {
      if (accountId !== acct()) return;
      const match = (a) => (mode === 'domain' ? a === value || a.endsWith(`@${value}`) || SS.domainOf(a).endsWith(`.${value}`) : a === value);
      dropItems(new Set(s.items.filter((m) => match(m.from.address)).map((m) => m.id)));
      refreshFoldersSoon();
    });
    for (const evt of ['restored', 'emptied', 'rules-ran']) {
      SS.bus.on(evt, (d) => {
        if (!d?.accountId || d.accountId === acct()) {
          refreshFoldersSoon();
          if (!(evt === 'rules-ran' && !d.total)) loadList();
        }
      });
    }
    setAccount();
  }

  // ---------- account & folders ----------

  async function setAccount() {
    s.folders = [];
    s.folderId = null;
    s.items = [];
    s.message = null;
    s.openId = null;
    if (!acct()) return renderWelcome();
    SS.replace(root, sidebar, listPane, reader);
    renderSidebar();
    renderList();
    renderReader();
    try {
      s.folders = await api('mail:folders', acct());
    } catch (e) {
      s.error = e.message;
      SS.console.log(e.message, 'error');
      renderList();
      return;
    }
    s.folderId = (s.folders.find((f) => f.special === 'inbox') || s.folders.find((f) => f.selectable))?.id;
    renderSidebar();
    loadList();
  }

  let folderTimer = null;
  function refreshFoldersSoon() {
    clearTimeout(folderTimer);
    folderTimer = setTimeout(async () => {
      try {
        s.folders = await api('mail:folders', acct());
        renderSidebar();
        renderHead();
      } catch {
        /* ignore */
      }
    }, 700);
  }

  function renderWelcome() {
    SS.replace(
      root,
      h(
        'div',
        { class: 'welcome' },
        h(
          'div',
          { class: 'welcome-inner' },
          h('h1', null, 'Clean up your email'),
          h('p', null, 'Quiet Inbox shows you who sends the most email, lets you delete it all in one go, and blocks senders you never want to hear from again.'),
          h(
            'ul',
            null,
            h('li', null, icon('check'), 'Nothing is deleted without asking you first.'),
            h('li', null, icon('check'), 'Deleted emails go to Trash, so you can change your mind.'),
            h('li', null, icon('check'), 'Pictures in spam stay hidden, so senders can’t tell you opened it.')
          ),
          h('button', { class: 'btn primary lg', type: 'button', onclick: () => SS.addAccount() }, icon('plus'), 'Add your email account')
        )
      )
    );
  }

  function renderSidebar() {
    const showAll = !!SS.state.settings.showAllFolders;
    const accounts = SS.state.accounts.map((a) =>
      h(
        'button',
        { class: 'account', type: 'button', 'aria-current': String(a.id === acct()), onclick: () => a.id !== acct() && SS.selectAccount(a.id) },
        h('span', { class: SS.avatarClass(a.service) }, SS.initial('', a.email)),
        h('span', { class: 'account-email' }, a.email)
      )
    );
    const folderBtn = (f, depth = 0) =>
      h(
        'button',
        { class: 'folder', type: 'button', 'aria-current': String(f.id === s.folderId), style: depth ? { 'padding-left': `${8 + depth * 14}px` } : null, onclick: () => selectFolder(f.id) },
        icon(SS.folderIcon(f.special)),
        h('span', { class: 'folder-name' }, f.special === 'junk' ? 'Spam' : f.name),
        f.unread && ['inbox', 'junk'].includes(f.special) ? h('span', { class: 'folder-count' }, fmt.num(f.unread)) : f.special === 'trash' && f.total ? h('span', { class: 'folder-count' }, fmt.num(f.total)) : null
      );
    const selectable = s.folders.filter((f) => f.selectable);
    const main = MAIN.map((k) => selectable.find((f) => f.special === k)).filter(Boolean);
    const others = selectable.filter((f) => !main.includes(f));
    SS.replace(
      sidebar,
      h('div', { class: 'accounts' }, accounts, h('button', { class: 'btn ghost sm add-email', type: 'button', onclick: () => SS.addAccount() }, icon('plus'), 'Add another email')),
      h(
        'nav',
        { class: 'folders', 'aria-label': 'Folders' },
        main.map((f) => folderBtn(f)),
        others.length
          ? h(
              'button',
              { class: 'folder folder-more', type: 'button', 'aria-expanded': String(showAll), onclick: () => SS.saveSetting('showAllFolders', !showAll).then(renderSidebar) },
              icon('chevron'),
              h('span', { class: 'folder-name' }, showAll ? 'Fewer folders' : `More folders (${others.length})`)
            )
          : null,
        showAll ? others.map((f) => folderBtn(f, Math.min(f.depth, 3))) : null
      )
    );
  }

  function selectFolder(id) {
    if (id === s.folderId && !s.query) return;
    s.folderId = id;
    s.query = '';
    s.openId = null;
    s.message = null;
    renderSidebar();
    renderReader();
    loadList();
  }

  // ---------- list ----------

  async function loadList({ reset = true } = {}) {
    if (!s.folderId) return;
    const token = ++s.token;
    if (reset) {
      s.items = [];
      s.next = null;
      s.checked.clear();
      s.allInFolder = false;
      s.error = null;
    }
    s.loading = true;
    renderList();
    try {
      const r = await api('mail:list', acct(), s.folderId, { cursor: reset ? null : s.next, query: s.query, pageSize: 60 });
      if (token !== s.token) return;
      s.items = reset ? r.items : s.items.concat(r.items.filter((m) => !s.items.some((x) => x.id === m.id)));
      s.next = r.nextCursor;
      s.total = r.total;
    } catch (e) {
      if (token !== s.token) return;
      s.error = e.message;
      SS.console.log(e.message, 'error');
    }
    s.loading = false;
    renderList();
  }

  function dropItems(ids) {
    if (!ids.size) return;
    const openIdx = s.items.findIndex((m) => m.id === s.openId);
    s.items = s.items.filter((m) => !ids.has(m.id));
    for (const id of ids) s.checked.delete(id);
    if (s.total != null) s.total = Math.max(0, s.total - ids.size);
    if (ids.has(s.openId)) {
      const nextMsg = s.items[Math.min(openIdx, s.items.length - 1)];
      s.openId = null;
      s.message = null;
      if (nextMsg) openMessage(nextMsg);
      else renderReader();
    }
    renderList();
  }

  function renderHead() {
    const f = folder();
    if (!f || !listPane.querySelector('.list-head')) return;
    const meta = listPane.querySelector('.list-title .meta');
    if (meta) meta.textContent = s.query ? (s.loading ? 'Searching…' : `${fmt.plural(s.total ?? s.items.length, 'match', 'matches')}`) : s.total != null ? fmt.plural(s.total, 'email') : '';
  }

  function renderList() {
    const f = folder();
    const search = h('input', { class: 'input', type: 'search', placeholder: SS.account()?.isGmail ? 'Search mail' : 'Search by sender or subject', value: s.query, 'aria-label': 'Search mail' });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        s.query = search.value.trim();
        loadList();
      } else if (e.key === 'Escape' && s.query) {
        s.query = '';
        loadList();
      }
    });
    search.addEventListener('search', () => {
      if (!search.value && s.query) {
        s.query = '';
        loadList();
      }
    });
    const head = h(
      'div',
      { class: 'list-head' },
      h('div', { class: 'list-title' }, h('h2', null, f ? (f.special === 'junk' ? 'Spam' : f.name) : 'Mail'), h('span', { class: 'meta' }), h('button', { class: 'icon-btn', type: 'button', title: 'Check for new email', 'aria-label': 'Check for new email', onclick: () => (refreshFoldersSoon(), loadList()) }, icon('refresh'))),
      h('div', { class: 'search' }, icon('search'), search)
    );
    if (s.items.length) {
      const all = h('input', { type: 'checkbox', checked: s.items.every((m) => s.checked.has(m.id)), 'aria-label': 'Select all' });
      all.indeterminate = s.checked.size > 0 && !all.checked;
      all.addEventListener('change', () => {
        s.allInFolder = false;
        if (all.checked) s.items.forEach((m) => s.checked.add(m.id));
        else s.checked.clear();
        renderList();
      });
      head.append(h('label', { class: 'check select-all' }, all, h('span', null, 'Select all')));
    }
    const parts = [head];
    if (f && ['trash', 'junk'].includes(f.special) && (f.total || s.items.length)) {
      const name = f.special === 'junk' ? 'Spam' : 'Trash';
      parts.push(h('div', { class: 'empty-bar' }, h('span', null, `Emails in ${name} still take up space.`), h('button', { class: 'btn sm danger-ghost', type: 'button', onclick: () => SS.actions.emptyFolder(acct(), f).catch(() => {}) }, icon('purge'), `Empty ${name}`)));
    }
    if (s.checked.size) {
      const sel = selected();
      const inTrash = f?.special === 'trash';
      const name = f ? (f.special === 'junk' ? 'Spam' : f.name) : '';
      const allLoaded = s.items.length > 0 && s.items.every((m) => s.checked.has(m.id));
      const more = !s.query && f && allLoaded && (s.next || (f.total || 0) > s.items.length);
      const label = s.allInFolder ? `All emails in ${name} selected` : `${fmt.num(s.checked.size)} selected`;
      parts.push(
        h(
          'div',
          { class: 'bulkbar' },
          h(
            'span',
            { class: 'count' },
            label,
            more && !s.allInFolder ? h('button', { class: 'link', type: 'button', style: { 'margin-left': '10px' }, onclick: () => ((s.allInFolder = true), renderList()) }, `Select all ${fmt.num(f.total || 0)} in ${name}`) : null,
            s.allInFolder ? h('small', { class: 'muted', style: { 'margin-left': '8px', 'font-weight': 400 } }, '(starred ones are kept)') : null
          ),
          inTrash ? null : h('button', { class: 'btn sm', type: 'button', onclick: () => (s.allInFolder ? SS.actions.folderAction(acct(), f, 'trash').catch(() => {}) : del(sel)) }, icon('trash'), 'Delete'),
          h('button', { class: 'btn sm danger-ghost', type: 'button', onclick: () => (s.allInFolder ? SS.actions.folderAction(acct(), f, 'destroy').catch(() => {}) : destroy(sel)) }, icon('purge'), 'Delete forever'),
          h('button', { class: 'btn sm ghost', type: 'button', onclick: () => (s.checked.clear(), (s.allInFolder = false), renderList()) }, 'Clear')
        )
      );
    }
    rows.clear();
    listEl = h('div', { class: 'msg-list', role: 'listbox', 'aria-label': 'Emails', tabindex: '0' }, s.items.map((m, i) => row(m, i)));
    let footText = '';
    if (s.loading) footText = s.items.length ? 'Loading more…' : 'Loading your email…';
    else if (s.error) footText = s.error;
    else if (!s.items.length) footText = s.query ? 'No emails match that search.' : 'There are no emails here.';
    else if (!s.next) footText = s.items.length > 20 ? 'That’s everything.' : '';
    const needsSignIn = s.error && /sign in again/i.test(s.error) && SS.account()?.kind === 'microsoft';
    foot = h(
      'div',
      { class: 'list-foot' },
      s.loading ? h('div', { class: 'loading', style: { 'justify-content': 'center' } }, SS.spinner(), footText) : footText,
      needsSignIn ? h('div', { style: { 'margin-top': '12px' } }, h('button', { class: 'btn primary', type: 'button', onclick: () => SS.reauthAccount(SS.account()) }, 'Sign in again')) : null
    );
    listEl.append(foot);
    parts.push(listEl);
    const scroll = listPane.querySelector('.msg-list')?.scrollTop || 0;
    SS.replace(listPane, parts);
    listEl.scrollTop = scroll;
    observer.disconnect();
    if (s.next) observer.observe(foot);
    renderHead();
  }

  function row(m, i) {
    const checkbox = h('input', { type: 'checkbox', checked: s.checked.has(m.id), 'aria-label': `Select email from ${fromName(m)}` });
    checkbox.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCheck(m, i, e.shiftKey, checkbox.checked);
    });
    const more = h('button', { class: 'icon-btn msg-more', type: 'button', 'aria-label': 'More options', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon('more'));
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      SS.menu(more, messageMenu(m));
    });
    const star = h('button', { class: `icon-btn msg-star ${m.flagged ? 'on' : ''}`, type: 'button', 'aria-pressed': String(!!m.flagged), 'aria-label': m.flagged ? 'Remove star' : 'Star this email', title: m.flagged ? 'Starred: bulk deletes skip this email' : 'Star to keep it safe' }, icon('star'));
    star.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleStar(m);
    });
    const el = h(
      'div',
      {
        class: `msg ${m.seen ? '' : 'unread'} ${s.checked.has(m.id) ? 'checked' : ''}`,
        role: 'option',
        'aria-selected': String(m.id === s.openId),
        onclick: () => openMessage(m),
        oncontextmenu: (e) => {
          e.preventDefault();
          SS.menu(more, messageMenu(m));
        },
      },
      h('label', { class: 'msg-check', onclick: (e) => e.stopPropagation() }, checkbox),
      h(
        'div',
        { class: 'msg-main' },
        h('div', { class: 'msg-top' }, h('span', { class: 'msg-from' }, fromName(m)), h('time', { class: 'msg-date' }, fmt.date(m.date))),
        h(
          'div',
          { class: 'msg-bottom' },
          h('span', { class: 'msg-subject' }, m.subject || '(no subject)'),
          h('span', { class: 'msg-tags' }, m.hasAttachments ? h('span', { title: 'Has attachments' }, icon('clip')) : null),
          h('span', { class: `msg-size ${m.size >= BIG ? 'big' : ''}`, title: 'Size' }, fmt.bytes(m.size))
        )
      ),
      star,
      more
    );
    rows.set(m.id, el);
    return el;
  }

  function toggleCheck(m, i, shift, on) {
    if (shift && s.anchor != null) {
      const [a, b] = [Math.min(s.anchor, i), Math.max(s.anchor, i)];
      for (let k = a; k <= b; k++) on ? s.checked.add(s.items[k].id) : s.checked.delete(s.items[k].id);
    } else on ? s.checked.add(m.id) : s.checked.delete(m.id);
    s.anchor = i;
    s.allInFolder = false;
    renderList();
  }

  function messageMenu(m) {
    const f = folder();
    const inTrash = f?.special === 'trash';
    return [
      inTrash ? null : { label: 'Delete', icon: 'trash', run: () => del([m]) },
      { label: 'Delete forever (frees up space)', icon: 'purge', danger: true, run: () => destroy([m]) },
      f?.special === 'junk' ? null : { label: 'Move to Spam', icon: 'junk', run: () => SS.actions.junkMessages(acct(), s.folderId, [m]).catch(() => {}) },
      { label: m.flagged ? 'Remove star' : 'Star (keep this email safe)', icon: 'star', run: () => toggleStar(m) },
      { label: m.seen ? 'Mark as unread' : 'Mark as read', icon: 'read', run: () => markRead(m, !m.seen) },
      'sep',
      ...SS.actions.senderItems(acct(), m.from.address, { name: m.from.name, unsubscribe: m.unsubscribe ? () => SS.actions.unsubscribe(acct(), s.folderId, m.id, m.from) : null }),
    ].filter(Boolean);
  }

  const del = (msgs) => (folder()?.special === 'trash' ? SS.actions.destroyMessages(acct(), s.folderId, msgs) : SS.actions.trashMessages(acct(), s.folderId, msgs)).catch(() => {});
  const destroy = (msgs) => SS.actions.destroyMessages(acct(), s.folderId, msgs).catch(() => {});

  async function toggleStar(m) {
    const on = !m.flagged;
    try {
      await api('mail:flag', acct(), s.folderId, [m.id], on);
      m.flagged = on;
      SS.console.log(on ? 'Starred. Bulk deletes and blocked senders will always skip this email.' : 'Star removed', 'ok');
      renderList();
      if (s.openId === m.id && s.message && !s.message.error) renderReader();
      refreshFoldersSoon();
    } catch (e) {
      SS.console.log(e.message, 'error');
    }
  }

  async function markRead(m, read) {
    try {
      await api('mail:markRead', acct(), s.folderId, [m.id], read);
      m.seen = read;
      rows.get(m.id)?.classList.toggle('unread', !read);
      refreshFoldersSoon();
    } catch (e) {
      SS.console.log(e.message, 'error');
    }
  }

  // ---------- reader ----------

  async function openMessage(m) {
    s.openId = m.id;
    s.message = null;
    s.showPics = !!SS.state.settings.remoteImages;
    s.showHeaders = false;
    for (const [id, el] of rows) el.setAttribute('aria-selected', String(id === m.id));
    rows.get(m.id)?.scrollIntoView({ block: 'nearest' });
    renderReader(true);
    const token = ++s.openToken;
    try {
      const msg = await api('mail:get', acct(), s.folderId, m.id);
      if (token !== s.openToken) return;
      s.message = { ...msg, summary: m };
      if (SS.state.settings.markReadOnOpen && !m.seen) {
        m.seen = true;
        rows.get(m.id)?.classList.remove('unread');
        refreshFoldersSoon();
      }
    } catch (e) {
      if (token !== s.openToken) return;
      s.message = { error: e.message };
    }
    renderReader();
  }

  function srcdoc(html, remote) {
    const r = remote ? ' https: http:' : '';
    const csp = `default-src 'none'; img-src data:${r}; style-src 'unsafe-inline'${r}; font-src data:${r}`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>html{color-scheme:light}body{margin:20px 24px;font:16px/1.55 'Segoe UI',system-ui,sans-serif;color:#16201B;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}pre{white-space:pre-wrap;font:inherit}a{color:#0E6B4F}</style></head><body>${html}</body></html>`;
  }

  function renderReader(loading = false) {
    const msg = s.message;
    if (!s.openId) {
      return SS.replace(
        reader,
        h(
          'div',
          { class: 'reader-empty' },
          h('h3', null, s.items.length ? 'Pick an email to read it' : ''),
          s.items.length ? h('p', null, 'Delete moves an email to Trash. Delete forever removes it for good and frees up space. The ', h('span', { class: 'kbd' }, 'Delete'), ' key works too.') : null
        )
      );
    }
    if (loading || !msg) return SS.replace(reader, h('div', { class: 'reader-empty' }, h('div', { class: 'loading' }, SS.spinner(), 'Opening…')));
    if (msg.error) return SS.replace(reader, h('div', { class: 'reader-empty' }, h('h3', null, 'This email couldn’t be opened'), h('p', null, msg.error)));

    const m = msg.summary;
    const inTrash = folder()?.special === 'trash';
    const more = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'More options', 'aria-haspopup': 'menu', onclick: () => SS.menu(more, messageMenu(m)) }, icon('more'));
    const a = msg.auth;
    const failed = a && (a.dmarc === 'fail' || (a.spf === 'fail' && a.dkim !== 'pass'));
    const verified = a && !failed && (a.dmarc === 'pass' || (a.spf === 'pass' && a.dkim === 'pass'));
    const hasRemote = /<img[^>]+src\s*=\s*["']?\s*https?:/i.test(msg.html) || /url\(\s*['"]?https?:/i.test(msg.html);
    const sender = msg.from.name || msg.from.address;

    const head = h(
      'header',
      { class: 'reader-head' },
      h(
        'div',
        { class: 'reader-top' },
        h('h1', { class: 'reader-subject' }, msg.subject || '(no subject)'),
        h(
          'div',
          { class: 'reader-actions' },
          inTrash ? null : h('button', { class: 'btn', type: 'button', onclick: () => del([m]) }, icon('trash'), 'Delete'),
          h('button', { class: 'btn danger-ghost', type: 'button', onclick: () => destroy([m]) }, icon('purge'), 'Delete forever'),
          h('button', { class: `btn ghost ${m.flagged ? 'starred' : ''}`, type: 'button', 'aria-pressed': String(!!m.flagged), onclick: () => toggleStar(m) }, icon('star'), m.flagged ? 'Starred' : 'Star'),
          h('button', { class: 'btn ghost', type: 'button', onclick: () => SS.actions.block(acct(), msg.from.address, { name: msg.from.name }).catch(() => {}) }, icon('junk'), 'Block sender'),
          more
        )
      ),
      h(
        'div',
        { class: 'reader-from' },
        h('span', { class: 'avatar' }, SS.initial(msg.from.name, msg.from.address)),
        h(
          'div',
          null,
          h('div', null, h('strong', null, sender), msg.from.name ? h('span', { class: 'reader-addr' }, ` <${msg.from.address}>`) : null),
          h('div', { class: 'reader-meta' }, h('span', null, fmt.dateLong(msg.date)), h('span', null, fmt.bytes(msg.size)))
        ),
        verified ? h('span', { class: 'verified', title: 'This email passed the sender check (SPF, DKIM, DMARC).' }, icon('shield'), 'Verified sender') : null,
        msg.unsubscribe ? h('button', { class: 'btn sm ghost details-btn', type: 'button', onclick: () => SS.actions.unsubscribe(acct(), s.folderId, m.id, msg.from).catch(() => {}) }, icon('unsub'), 'Unsubscribe') : null,
        h('button', { class: `btn sm ghost ${msg.unsubscribe ? '' : 'details-btn'}`, type: 'button', 'aria-pressed': String(s.showHeaders), onclick: () => ((s.showHeaders = !s.showHeaders), renderReader()) }, icon('code'), s.showHeaders ? 'Show email' : 'Details')
      )
    );
    const parts = [head];
    if (failed) parts.push(h('div', { class: 'notice', role: 'note' }, icon('alert'), h('span', null, h('b', null, 'Be careful. '), `This email may not really be from ${sender}. Don’t click its links or reply with personal information.`)));
    if (hasRemote && !s.showPics && !s.showHeaders) {
      parts.push(h('div', { class: 'reader-banner' }, icon('image'), h('span', null, 'Pictures are hidden so the sender can’t tell you opened this.'), h('button', { class: 'link', type: 'button', onclick: () => ((s.showPics = true), renderReader()) }, 'Show pictures')));
    }
    if (msg.attachments.length && !s.showHeaders) parts.push(h('div', { class: 'reader-attachments' }, msg.attachments.map((x) => h('span', { class: 'att' }, icon('clip'), x.name, h('span', null, fmt.bytes(x.size))))));
    if (s.showHeaders) parts.push(h('pre', { class: 'reader-headers' }, msg.headers));
    else {
      const frame = h('iframe', { title: 'Email content', sandbox: 'allow-popups allow-popups-to-escape-sandbox', referrerpolicy: 'no-referrer' });
      frame.srcdoc = srcdoc(msg.html, s.showPics);
      parts.push(h('div', { class: 'reader-body' }, frame));
    }
    SS.replace(reader, parts);
  }

  // ---------- keyboard ----------

  function onKey(e) {
    if (SS.state.view !== 'mail' || !acct() || document.querySelector('.overlay, .menu')) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const target = s.checked.size ? selected() : s.items.filter((m) => m.id === s.openId);
    if (e.key === 'Delete' && target.length) {
      e.preventDefault();
      e.shiftKey ? destroy(target) : del(target);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const i = s.items.findIndex((m) => m.id === s.openId);
      const n = s.items[e.key === 'ArrowDown' ? i + 1 : Math.max(0, i - 1)];
      if (n) {
        e.preventDefault();
        openMessage(n);
      }
    } else if (e.key === 'Escape' && s.checked.size) {
      s.checked.clear();
      renderList();
    }
  }

  SS.Mail = { mount, reload: () => loadList() };
})();
