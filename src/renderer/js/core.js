'use strict';

(() => {
  const SS = (window.SS = {});

  // ---------- bridge ----------
  SS.api = async (channel, ...args) => {
    const r = await window.spamSweep.invoke(channel, ...args);
    if (!r.ok) throw new Error(r.error);
    return r.data;
  };
  SS.on = (event, cb) => window.spamSweep.on(event, cb);

  // ---------- shared state + bus ----------
  SS.state = { accounts: [], accountId: null, settings: {}, view: 'mail' };
  const listeners = new Map();
  SS.bus = {
    on(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, new Set());
      listeners.get(evt).add(fn);
    },
    emit(evt, data) {
      for (const fn of listeners.get(evt) || []) {
        try {
          fn(data);
        } catch (e) {
          console.error(e);
        }
      }
    },
  };
  SS.account = (id = SS.state.accountId) => SS.state.accounts.find((a) => a.id === id) || null;

  // ---------- DOM ----------
  const PROPS = new Set(['value', 'checked', 'selected', 'indeterminate', 'disabled']);
  function h(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'style' && typeof v === 'object') {
          for (const [sk, sv] of Object.entries(v)) e.style.setProperty(sk, sv);
        } else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'dataset') Object.assign(e.dataset, v);
        else if (PROPS.has(k)) e[k] = v;
        else if (v === true) e.setAttribute(k, '');
        else e.setAttribute(k, v);
      }
    }
    add(e, children);
    return e;
  }
  function add(e, children) {
    for (const c of [children].flat(Infinity)) {
      if (c == null || c === false) continue;
      e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return e;
  }
  SS.h = h;
  SS.clear = (e) => {
    while (e.firstChild) e.firstChild.remove();
    return e;
  };
  SS.replace = (e, ...children) => add(SS.clear(e), children);

  // ---------- icons (constant markup only) ----------
  const ICONS = {
    more: '<circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
    purge: '<path d="M4 7h16M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3M10 11.5l4 5M14 11.5l-4 5"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    clip: '<path d="m20 12-8.5 8.5a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8.5-8.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    rule: '<path d="M4 5h16l-6 7.5V18l-4 2v-7.5z"/>',
    junk: '<circle cx="12" cy="12" r="8.5"/><path d="m6 6 12 12"/>',
    unsub: '<path d="M4 6h16v12H4z"/><path d="m4 7 8 6 8-6"/><path d="M15 15l5 5M20 15l-5 5"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>',
    inbox: '<path d="M3 13h5l1.5 3h5L16 13h5M5.5 5h13L21 13v6H3v-6z"/>',
    folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z"/>',
    send: '<path d="M21 3 3 10.5l7.5 3L14 21z"/><path d="m10.5 13.5 4.5-4.5"/>',
    draft: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
    archive: '<rect x="3" y="4" width="18" height="4.5" rx="1"/><path d="M5 8.5V19h14V8.5M10 12.5h4"/>',
    all: '<path d="M3 8.5 12 4l9 4.5-9 4.5z"/><path d="m3 13 9 4.5 9-4.5"/>',
    flag: '<path d="M5 21V4h11l-1.5 4L16 12H5"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>',
    chart: '<path d="M5 20V11M11 20V5M17 20v-6M3 20h18"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
    image: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5-9 8.5"/>',
    code: '<path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4"/>',
    read: '<path d="M3 10.5 12 4.5l9 6V19a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="m3.5 11 8.5 5.5 8.5-5.5"/>',
    shield: '<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z"/>',
    alert: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17.2v.3"/>',
    list: '<path d="M8 6.5h12M8 12h12M8 17.5h12M4 6.5h.01M4 12h.01M4 17.5h.01"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    key: '<circle cx="8" cy="14.5" r="4"/><path d="m11 11.5 8.5-8.5M16 6l3 3M14 8l2 2"/>',
    star: '<path d="m12 3.6 2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z"/>',
    sweep: '<path d="M3 6.5h12.5M3 11h9.5M3 15.5h6M14 21l4.2-9.5a1.6 1.6 0 0 1 2.9 1.3L17 21zM14 21h7"/>',
  };
  const FILLED = new Set(['more']);
  SS.icon = (name, cls = '') => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('class', `ic ${FILLED.has(name) ? 'fill' : ''} ${cls}`.trim());
    s.innerHTML = ICONS[name] || '';
    return s;
  };
  SS.folderIcon = (special) => ({ inbox: 'inbox', junk: 'junk', trash: 'trash', sent: 'send', drafts: 'draft', archive: 'archive', all: 'all', flagged: 'flag' })[special] || 'folder';
  SS.spinner = () => {
    const s = SS.icon('refresh', 'spin');
    return s;
  };

  // ---------- formatting ----------
  const nf = new Intl.NumberFormat();
  SS.fmt = {
    num: (n) => nf.format(n || 0),
    bytes(n) {
      n = Number(n) || 0;
      if (n < 1024) return `${n} B`;
      const u = ['KB', 'MB', 'GB', 'TB'];
      let i = -1;
      do {
        n /= 1024;
        i++;
      } while (n >= 1024 && i < u.length - 1);
      return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
    },
    date(v) {
      if (!v) return '';
      const d = new Date(v);
      if (isNaN(d)) return '';
      const now = new Date();
      if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
      return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    },
    dateLong(v) {
      if (!v) return '';
      const d = new Date(v);
      return isNaN(d) ? '' : d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    },
    ago(ts) {
      if (!ts) return 'never';
      const s = Math.round((Date.now() - ts) / 1000);
      if (s < 45) return 'just now';
      const m = Math.round(s / 60);
      if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
      const hr = Math.round(m / 60);
      if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
      const d = Math.round(hr / 24);
      return `${d} day${d === 1 ? '' : 's'} ago`;
    },
    pct: (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '0%'),
    plural: (n, word, many = `${word}s`) => `${nf.format(n)} ${n === 1 ? word : many}`,
  };
  SS.initial = (name, address) => (String(name || address || '?').replace(/[^\p{L}\p{N}]/gu, '')[0] || '?').toUpperCase();
  SS.domainOf = (a) => String(a || '').split('@').pop().toLowerCase();

  // ---------- console strip ----------
  const Console = {
    entries: [],
    busyCount: 0,
    undoTimer: null,
    init(root) {
      this.text = h('span', { class: 'console-text', role: 'status', 'aria-live': 'polite' }, 'Ready');
      this.busyEl = h('span', { class: 'busy', hidden: true });
      this.undoBtn = h('button', { type: 'button', class: 'undo', hidden: true }, 'Undo');
      this.freedEl = h('span');
      this.toggle = h('button', { type: 'button', 'aria-expanded': 'false', onclick: () => this.setOpen(this.logEl.hidden) }, 'History');
      this.logEl = h('div', { class: 'console-log', hidden: true, role: 'log' });
      const line = h('div', { class: 'console-line' }, this.busyEl, this.text, this.undoBtn);
      SS.replace(root, line, h('div', { class: 'console-right' }, this.freedEl, this.toggle), this.logEl);
      document.addEventListener('mousedown', (e) => {
        if (!this.logEl.hidden && !root.contains(e.target)) this.setOpen(false);
      });
    },
    setOpen(open) {
      this.logEl.hidden = !open;
      this.toggle.setAttribute('aria-expanded', String(open));
      if (open) this.logEl.scrollTop = this.logEl.scrollHeight;
    },
    log(text, kind = 'info', { busy = false } = {}) {
      if (!text) return;
      this.text.textContent = text;
      this.text.className = `console-text ${kind === 'error' ? 'err' : kind === 'ok' ? 'ok' : ''}`;
      this.busyEl.hidden = !busy && this.busyCount === 0;
      if (!busy) this.hideUndo();
      const last = this.entries[this.entries.length - 1];
      if (busy && last?.busy) {
        last.row.lastChild.textContent = text;
        return;
      }
      const row = h('div', { class: kind === 'error' ? 'err' : kind === 'ok' ? 'ok' : '' }, h('time', null, new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })), h('span', null, text));
      this.entries.push({ busy, row });
      this.logEl.append(row);
      if (this.entries.length > 300) this.entries.shift().row.remove();
    },
    offerUndo(accountIds) {
      const ids = [].concat(accountIds || []).filter(Boolean);
      if (!ids.length) return;
      this.undoBtn.hidden = false;
      this.undoBtn.onclick = async () => {
        this.hideUndo();
        try {
          let n = 0;
          await SS.task('Bringing them back', async () => {
            for (const id of ids) n += (await SS.api('mail:undo', id)).count;
          }, { done: () => `Brought back ${SS.fmt.plural(n, 'email')}` });
          for (const id of ids) SS.bus.emit('restored', { accountId: id });
        } catch {
          /* shown in the status bar */
        }
      };
      clearTimeout(this.undoTimer);
      this.undoTimer = setTimeout(() => this.hideUndo(), 90000);
    },
    hideUndo() {
      this.undoBtn.hidden = true;
      clearTimeout(this.undoTimer);
    },
    setFreed(bytes) {
      SS.replace(this.freedEl, bytes ? ['Space freed so far: ', h('b', null, SS.fmt.bytes(bytes))] : '');
    },
  };
  SS.console = Console;

  /** Run work with the console showing what is happening. Re-throws so callers can react. */
  SS.task = async (label, fn, { done } = {}) => {
    Console.busyCount++;
    Console.log(`${label}…`, 'info', { busy: true });
    try {
      const r = await fn();
      Console.busyCount--;
      const msg = typeof done === 'function' ? done(r) : done;
      if (msg !== null) Console.log(msg || `${label}: done`, 'ok');
      else Console.busyEl.hidden = Console.busyCount === 0;
      return r;
    } catch (e) {
      Console.busyCount--;
      Console.log(e.message, 'error');
      throw e;
    }
  };

  // ---------- modal ----------
  SS.modal = ({ title, body, actions = [], wide = false, dismissable = true }) => {
    let resolve;
    const result = new Promise((r) => (resolve = r));
    const prevFocus = document.activeElement;
    const bodyEl = h('div', { class: 'modal-body' });
    const errEl = h('div', { class: 'modal-error', hidden: true, role: 'alert' });
    const foot = h('div', { class: 'modal-foot' });
    const titleEl = h('h2', { id: 'modal-title' }, title);
    const box = h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-title' }, h('div', { class: 'modal-head' }, titleEl), bodyEl, foot);
    const overlay = h('div', { class: 'overlay' }, box);
    let closed = false;
    const close = (value = null) => {
      if (closed) return;
      closed = true;
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape' && dismissable) {
        e.stopPropagation();
        close(null);
      }
    };
    // Clicking outside the dialog does nothing: it only closes from its own buttons (or Escape),
    // so a stray click can't throw away a confirmation.
    document.addEventListener('keydown', onKey, true);

    const ctl = {
      el: box,
      body: bodyEl,
      result,
      close,
      setTitle: (t) => (titleEl.textContent = t),
      setBody(...nodes) {
        SS.replace(bodyEl, nodes, errEl);
      },
      error(msg) {
        errEl.textContent = msg || '';
        errEl.hidden = !msg;
      },
      setActions(list) {
        SS.clear(foot);
        for (const a of list) {
          const b = h('button', { class: `btn ${a.kind || ''}`, type: 'button', disabled: !!a.disabled }, a.icon ? SS.icon(a.icon) : null, a.label);
          b.addEventListener('click', async () => {
            // An explicit `value: null` (Cancel) must come back as null, not fall through to the label.
            if (!a.run) return close('value' in a ? a.value : a.label);
            ctl.error('');
            const buttons = [...foot.querySelectorAll('button')];
            buttons.forEach((x) => (x.disabled = true));
            const spin = SS.spinner();
            b.prepend(spin);
            try {
              const r = await a.run(ctl);
              if (r === false) {
                buttons.forEach((x) => (x.disabled = false));
                spin.remove();
                return;
              }
              close(r === undefined ? ('value' in a ? a.value : true) : r);
            } catch (e) {
              ctl.error(e.message);
              buttons.forEach((x) => (x.disabled = false));
              spin.remove();
            }
          });
          if (a.autofocus) setTimeout(() => b.focus(), 0);
          foot.append(b);
        }
        if (!list.some((a) => a.autofocus)) setTimeout(() => (foot.lastChild || box).focus?.(), 0);
      },
    };
    ctl.setBody(body);
    ctl.setActions(actions);
    document.body.append(overlay);
    return ctl;
  };

  SS.alert = (title, message) => SS.modal({ title, body: h('p', null, message), actions: [{ label: 'OK', kind: 'primary', autofocus: true }] }).result;

  SS.confirm = ({ title, body, confirm = 'Continue', danger = false }) =>
    SS.modal({
      title,
      body,
      actions: [
        { label: 'Cancel', kind: 'ghost', value: false },
        { label: confirm, kind: danger ? 'danger' : 'primary', value: true, autofocus: !danger },
      ],
    }).result.then((v) => v === true);

  SS.warning = (text) => h('div', { class: 'warn' }, SS.icon('alert'), h('span', null, text));

  // ---------- menu ----------
  let openMenu = null;
  SS.closeMenu = () => {
    if (openMenu) openMenu();
  };
  SS.menu = (anchor, items) => {
    SS.closeMenu();
    const el = h('div', { class: 'menu', role: 'menu' });
    for (const it of items) {
      if (it === 'sep') el.append(h('hr'));
      else if (it.heading) el.append(h('div', { class: 'menu-head' }, it.heading));
      else {
        el.append(
          h(
            'button',
            {
              type: 'button',
              role: 'menuitem',
              class: it.danger ? 'danger' : '',
              disabled: !!it.disabled,
              title: it.title || null,
              onclick: () => {
                close();
                it.run();
              },
            },
            SS.icon(it.icon || 'chevron'),
            h('span', null, it.label)
          )
        );
      }
    }
    document.body.append(el);
    const r = anchor.getBoundingClientRect();
    const mw = el.offsetWidth;
    const mh = el.offsetHeight;
    let left = r.right - mw;
    if (left < 8) left = Math.min(r.left, window.innerWidth - mw - 8);
    let top = r.bottom + 4;
    if (top + mh > window.innerHeight - 40) top = Math.max(8, r.top - mh - 4);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    anchor.setAttribute('aria-expanded', 'true');
    const btns = () => [...el.querySelectorAll('button:not(:disabled)')];
    setTimeout(() => btns()[0]?.focus(), 0);
    const onKey = (e) => {
      const list = btns();
      const i = list.indexOf(document.activeElement);
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        anchor.focus();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        list[(i + 1) % list.length]?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        list[(i - 1 + list.length) % list.length]?.focus();
      }
    };
    const onDown = (e) => {
      if (!el.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) close();
    };
    function close() {
      el.remove();
      anchor.setAttribute('aria-expanded', 'false');
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('blur', close);
      openMenu = null;
    }
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('blur', close);
    openMenu = close;
  };

  // ---------- theme ----------
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  SS.applyTheme = (pref = SS.state.settings.theme || 'system') => {
    const resolved = pref === 'system' ? (mq.matches ? 'dark' : 'light') : pref;
    document.documentElement.dataset.theme = resolved;
    SS.api('app:theme', resolved).catch(() => {});
  };
  mq.addEventListener('change', () => SS.applyTheme());
})();
