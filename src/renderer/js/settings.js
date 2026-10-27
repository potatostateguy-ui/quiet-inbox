'use strict';

(() => {
  const { h, api, fmt, icon } = SS;
  let page;
  const PHRASE = {
    trash: 'Moved to Trash',
    delete: 'Deleted forever',
    'trash-sender': 'Moved to Trash: everything from',
    'delete-sender': 'Deleted forever: everything from',
    junk: 'Moved to Spam',
    empty: 'Emptied',
    block: 'Blocked',
    blocked: 'Removed mail from',
    unsubscribe: 'Unsubscribed through',
    undo: 'Brought back',
  };

  function mount(el) {
    page = h('div', { class: 'page' });
    SS.replace(el, page);
    SS.bus.on('accounts-changed', () => SS.state.view === 'settings' && render());
  }

  function seg(options, current, onPick, cls = 'seg') {
    return h('div', { class: cls, role: 'group' }, options.map(([v, label]) => h('button', { type: 'button', 'aria-pressed': String(v === current), onclick: () => onPick(v) }, label)));
  }

  async function render() {
    const st = SS.state.settings;
    const activity = await api('activity:list').catch(() => ({ entries: [], freed: 0 }));
    const set = (k, v) => SS.saveSetting(k, v).then(render);
    const ms = await api('app:msStatus').catch(() => ({}));
    // Shows the ID in use (built-in or edited) so it can be changed in place.
    const idInput = h('input', { class: 'input', style: { flex: '1', 'min-width': '320px' }, value: st.microsoftClientId || ms.builtIn || '', placeholder: '1a2b3c4d-1111-2222-3333-444455556666', spellcheck: 'false', 'aria-label': 'Microsoft client ID' });
    const saveId = async (value) => {
      try {
        await SS.saveSetting('microsoftClientId', value);
        SS.console.log(value ? 'Microsoft sign-in is ready' : 'Using the built-in Microsoft setting', 'ok');
        render();
      } catch (e) {
        SS.console.log(e.message, 'error');
      }
    };
    const msSection = h(
      'section',
      null,
      h('h2', null, 'Microsoft sign-in'),
      h(
        'p',
        null,
        ms.clientId
          ? `Ready. Outlook, Hotmail and MSN addresses can be added any time. ${ms.source === 'built-in' ? 'Using the ID built into this copy.' : 'Using an ID changed here in Settings.'}`
          : 'Not set up yet. Paste the Application (client) ID from your Entra app registration to allow Outlook, Hotmail and MSN addresses. No rebuild needed.'
      ),
      h(
        'div',
        { class: 'row' },
        idInput,
        h('button', { class: 'btn', type: 'button', onclick: () => saveId(idInput.value.trim() === ms.builtIn ? '' : idInput.value) }, 'Save'),
        st.microsoftClientId && ms.builtIn ? h('button', { class: 'btn ghost', type: 'button', onclick: () => saveId('') }, 'Use built-in') : null
      )
    );
    const inner = h('div', { class: 'page-inner' });
    SS.replace(page, inner);
    inner.append(
      h('div', { class: 'page-head' }, h('h1', null, 'Settings')),
      h(
        'div',
        { class: 'settings' },
        h(
          'section',
          null,
          h('h2', null, 'Email accounts'),
          h('p', null, 'Passwords and sign-ins are stored encrypted on this computer only.'),
          SS.state.accounts.length
            ? h(
                'div',
                { class: 'acct-list' },
                SS.state.accounts.map((a) =>
                  h(
                    'div',
                    { class: 'acct-row' },
                    h('span', { class: SS.avatarClass(a.service) }, SS.initial('', a.email)),
                    h('div', { class: 'who' }, h('b', null, a.email), h('span', null, a.host)),
                    a.kind === 'microsoft' ? h('button', { class: 'btn ghost', type: 'button', onclick: () => SS.reauthAccount(a) }, 'Sign in again') : null,
                    h('button', { class: 'btn ghost', type: 'button', onclick: () => SS.removeAccount(a) }, 'Remove')
                  )
                )
              )
            : null,
          h('div', { class: 'row', style: { 'margin-top': '12px' } }, h('button', { class: 'btn', type: 'button', onclick: () => SS.addAccount() }, icon('plus'), 'Add an email account'))
        ),
        h(
          'section',
          null,
          h('h2', null, 'Text size'),
          h('p', null, 'Makes everything in Quiet Inbox bigger or smaller.'),
          seg([['normal', 'Normal'], ['large', 'Large'], ['larger', 'Extra large']], st.textSize || 'normal', (v) => set('textSize', v), 'size-seg')
        ),
        h(
          'section',
          null,
          h('h2', null, 'Reading email'),
          h(
            'div',
            { class: 'stack' },
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!st.remoteImages, onchange: (e) => set('remoteImages', e.target.checked) }), h('span', null, h('b', null, 'Show pictures automatically'), h('br'), h('small', null, 'Off is safer. Spammers use hidden pictures to see when you open their email.'))),
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!st.markReadOnOpen, onchange: (e) => set('markReadOnOpen', e.target.checked) }), h('span', null, h('b', null, 'Mark emails as read when I open them')))
          )
        ),
        h('section', null, h('h2', null, 'Colors'), seg([['light', 'Light'], ['dark', 'Dark'], ['system', 'Match Windows']], st.theme || 'light', (v) => set('theme', v).then(() => SS.applyTheme(v)))),
        h(
          'section',
          null,
          h('h2', null, 'Running in the background'),
          h('p', null, 'So blocked senders keep getting removed even when the window is closed. Quiet Inbox sits by the clock in the system tray; right-click its icon to open or quit it.'),
          h(
            'div',
            { class: 'stack' },
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!st.runInBackground, onchange: (e) => set('runInBackground', e.target.checked) }), h('span', null, h('b', null, 'Keep running in the tray when I close the window'))),
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!st.startWithWindows, onchange: (e) => set('startWithWindows', e.target.checked) }), h('span', null, h('b', null, 'Start Quiet Inbox when Windows starts'), h('br'), h('small', null, 'It starts quietly in the tray, without opening a window.')))
          )
        ),
        h(
          'section',
          null,
          h('h2', null, 'Blocked senders'),
          h(
            'div',
            { class: 'row' },
            h('span', null, 'While Quiet Inbox is open, check every'),
            h('select', { class: 'select', 'aria-label': 'How often', onchange: (e) => set('ruleIntervalMin', Number(e.target.value)) }, [5, 15, 30, 60].map((n) => h('option', { value: String(n), selected: n === (st.ruleIntervalMin || 15) }, `${n} minutes`)))
          )
        ),
        h(
          'section',
          null,
          h('h2', null, 'What Quiet Inbox has done'),
          h('p', null, activity.freed ? `Space freed so far: ${fmt.bytes(activity.freed)}.` : 'Nothing yet.'),
          activity.entries.length
            ? h(
                'div',
                { class: 'log' },
                activity.entries.slice(0, 100).map((e) =>
                  h('div', { class: 'log-row' }, h('span', { class: 'muted' }, fmt.dateLong(e.ts)), h('span', null, `${PHRASE[e.action] || e.action} ${e.target || ''}`), h('span', { class: 'num' }, e.count ? fmt.plural(e.count, 'email') : ''), h('span', { class: 'num muted' }, e.permanent && e.bytes ? fmt.bytes(e.bytes) : ''))
                )
              )
            : null
        ),
        msSection,
        h(
          'section',
          null,
          h('h2', null, 'Troubleshooting'),
          h(
            'div',
            { class: 'row' },
            h('button', { class: 'btn', type: 'button', onclick: () => api('app:openDataFolder') }, icon('folder'), 'Open data folder'),
            h('button', { class: 'btn', type: 'button', onclick: () => api('cache:clear').then(() => SS.console.log('Forgot saved cleanup checks', 'ok')) }, 'Forget saved cleanup checks')
          )
        )
      )
    );
  }

  SS.Settings = { mount, onShow: render };
})();
