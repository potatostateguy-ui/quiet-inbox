'use strict';

(() => {
  const { h, api, fmt, icon } = SS;
  const FREEMAIL = new Set(['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'aol.com', 'live.com', 'msn.com', 'me.com', 'comcast.net', 'att.net']);
  let page;
  let data = null;
  const acct = () => SS.state.accountId;

  function mount(el) {
    page = h('div', { class: 'page' });
    SS.replace(el, page);
    SS.bus.on('rules-changed', () => SS.state.view === 'rules' && load());
    SS.bus.on('account', () => SS.state.view === 'rules' && load());
    SS.bus.on('rules-ran', () => SS.state.view === 'rules' && load());
  }

  async function load() {
    data = acct() ? await api('rules:list', acct()).catch((e) => (SS.console.log(e.message, 'error'), null)) : null;
    render();
  }

  async function add(input, actionSel) {
    const raw = input.value.trim().toLowerCase().replace(/^mailto:/, '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    if (!raw) return input.focus();
    const mode = raw.includes('@') ? 'sender' : 'domain';
    const value = raw.replace(/^@/, '');
    if (mode === 'domain' && FREEMAIL.has(value)) {
      const ok = await SS.confirm({ title: `Block everyone at ${value}?`, body: [SS.warning(`${value} is used by millions of people. This would delete email from friends and family too.`)], confirm: `Block all of ${value}`, danger: true });
      if (!ok) return;
    }
    try {
      const r = await SS.task(`Blocking ${value}`, () => api('rules:create', acct(), { mode, value, action: actionSel.value, cleanup: true }), {
        done: (r) => `Blocked ${mode === 'domain' ? `everyone from ${value}` : value}${r.cleaned?.count ? ` and deleted ${fmt.plural(r.cleaned.count, 'email')}` : ''}`,
      });
      if (r.cleaned?.undoable) SS.console.offerUndo(acct());
      if (r.cleaned?.count) SS.bus.emit('purged', { accountId: acct(), value, mode, permanent: actionSel.value === 'permanent' });
      input.value = '';
      load();
    } catch {
      /* shown in status bar */
    }
  }

  function render() {
    const inner = h('div', { class: 'page-inner' });
    SS.replace(page, inner);
    const every = SS.state.settings.ruleIntervalMin || 15;
    inner.append(
      h(
        'div',
        { class: 'page-head' },
        h('h1', null, 'Blocked senders'),
        SS.state.accounts.length > 1 ? h('select', { class: 'select', 'aria-label': 'Email account', onchange: (e) => SS.selectAccount(e.target.value) }, SS.state.accounts.map((a) => h('option', { value: a.id, selected: a.id === acct() }, a.email))) : null,
        acct() ? h('button', { class: 'btn', type: 'button', onclick: () => SS.task('Checking for blocked senders', () => api('rules:runNow'), { done: null }).catch(() => {}) }, icon('refresh'), 'Check now') : null
      ),
      h('p', { class: 'lead' }, `Email from these senders is deleted automatically, every ${every} minutes while Quiet Inbox is running. It keeps running in the tray after you close the window. Starred emails are always kept.`)
    );
    if (!acct()) return inner.append(h('div', { class: 'empty' }, h('p', null, 'Add your email account first.')));
    const input = h('input', { class: 'input', placeholder: 'An email address, or a website like example.com', 'aria-label': 'Email address or website to block' });
    const actionSel = h('select', { class: 'select', 'aria-label': 'What to do' }, h('option', { value: 'trash' }, 'Move to Trash'), h('option', { value: 'permanent' }, 'Delete forever'));
    input.addEventListener('keydown', (e) => e.key === 'Enter' && add(input, actionSel));
    inner.append(h('div', { class: 'block-form' }, input, actionSel, h('button', { class: 'btn primary', type: 'button', onclick: () => add(input, actionSel) }, icon('junk'), 'Block')));
    const rules = data?.rules || [];
    if (!rules.length) {
      inner.append(h('div', { class: 'table' }, h('div', { class: 'empty' }, h('h3', null, 'No one is blocked yet'), h('p', null, 'Choose “Block sender” on any email, or type an address above.'))));
      return;
    }
    inner.append(
      h(
        'div',
        { class: 'table' },
        h('div', { class: 'trow thead cols-blocked' }, h('span', null, 'Sender'), h('span', null, 'Their email is'), h('span', null, 'Blocked on'), h('span')),
        rules
          .slice()
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((r) =>
            h(
              'div',
              { class: 'trow cols-blocked' },
              h('div', { class: 'who' }, h('b', null, r.mode === 'domain' ? `Everyone from ${r.value}` : r.value), r.lastRun ? h('span', null, `Last checked ${fmt.ago(r.lastRun)}`) : null),
              h('span', null, h('span', { class: `pill ${r.action === 'permanent' ? 'danger' : ''}` }, r.action === 'permanent' ? 'Deleted forever' : 'Moved to Trash')),
              h('span', { class: 'muted' }, fmt.date(r.createdAt)),
              h(
                'div',
                { class: 'acts' },
                h(
                  'button',
                  {
                    class: 'btn ghost',
                    type: 'button',
                    onclick: async () => {
                      await api('rules:delete', acct(), r.id);
                      SS.console.log(`Unblocked ${r.value}`, 'ok');
                      load();
                    },
                  },
                  'Unblock'
                )
              )
            )
          )
      )
    );
  }

  SS.Blocked = { mount, onShow: load };
})();
