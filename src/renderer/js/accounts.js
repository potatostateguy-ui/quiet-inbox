'use strict';

(() => {
  const { h, api, icon } = SS;
  const APP_PW = new Set(['gmail', 'yahoo', 'aol', 'icloud', 'fastmail', 'zoho']);

  SS.avatarClass = (service) => `avatar ${['gmail', 'yahoo', 'icloud'].includes(service) ? service : service === 'outlook' ? 'microsoft' : 'imap'}`;

  /** Two steps: type the email, then paste the password. Server details are found automatically. */
  SS.addAccount = async (prefill = '') => {
    let email = prefill;
    const m = SS.modal({ title: 'Add your email', body: [], actions: [] });
    const submitOnEnter = (input) =>
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') m.el.querySelector('.modal-foot .btn.primary')?.click();
      });

    function stepEmail() {
      const input = h('input', { class: 'input big-input', type: 'email', placeholder: 'name@example.com', value: email, autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Email address' });
      submitOnEnter(input);
      m.setTitle('Add your email');
      m.setBody(h('p', null, 'Type the email address you want to clean up.'), input);
      m.setActions([
        { label: 'Cancel', kind: 'ghost', value: null },
        {
          label: 'Next',
          kind: 'primary',
          run: async () => {
            email = input.value.trim();
            if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Type your full email address, like name@example.com.');
            stepPassword(await api('accounts:discover', email));
            return false;
          },
        },
      ]);
      setTimeout(() => input.focus(), 30);
    }

    /** Shown only if no Microsoft client ID has been added yet: paste it here once, no rebuild. */
    function stepMicrosoftSetup(found) {
      const input = h('input', { class: 'input big-input', placeholder: '1a2b3c4d-1111-2222-3333-444455556666', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Microsoft client ID' });
      submitOnEnter(input);
      m.setTitle('Turn on Microsoft sign-in');
      m.setBody(
        h('p', null, 'Outlook, Hotmail and MSN addresses need a one-time setting before they can sign in.'),
        h('p', { class: 'hint' }, 'Whoever set up Quiet Inbox: paste the Application (client) ID from your Entra app registration. You only do this once, and it can be changed later in Settings.'),
        input
      );
      m.setActions([
        { label: 'Back', kind: 'ghost', run: () => (stepEmail(), false) },
        {
          label: 'Save and continue',
          kind: 'primary',
          run: async () => {
            SS.state.settings = await api('settings:set', { microsoftClientId: input.value });
            stepMicrosoft({ ...found, available: true });
            return false;
          },
        },
      ]);
      setTimeout(() => input.focus(), 30);
    }

    /** Opens Microsoft's sign-in window straight away; it closes itself when she's done. */
    function stepMicrosoft(found) {
      if (!found.available) return stepMicrosoftSetup(found);
      let attempt = 0;
      const status = h('div', { class: 'signin-status', role: 'status' });
      const start = async (method) => {
        const my = ++attempt;
        SS.replace(status, h('div', { class: 'loading' }, SS.spinner(), h('span', null, method === 'browser' ? 'Waiting for you to finish in your web browser…' : 'Waiting for you to sign in…')));
        try {
          const r = await api('accounts:addMicrosoft', { email, tenant: found.tenant, method });
          if (my !== attempt) return;
          if (r.differs) SS.console.log(`Signed in as ${r.account.email}`, 'ok');
          m.close(r.account);
        } catch (e) {
          if (my !== attempt) return;
          SS.replace(
            status,
            h('div', { class: 'modal-error' }, e.message),
            h(
              'div',
              { class: 'row', style: { display: 'flex', gap: '8px', 'margin-top': '10px' } },
              h('button', { class: 'btn primary', type: 'button', onclick: () => start('window') }, 'Try again'),
              h('button', { class: 'btn ghost', type: 'button', onclick: () => start('browser') }, icon('external'), 'Use my web browser instead')
            )
          );
        }
      };
      const reopen = async (method) => {
        attempt++;
        await api('accounts:cancelSignIn').catch(() => {});
        start(method);
      };
      m.setTitle(`Sign in to ${email}`);
      m.setBody(
        h('div', { class: 'provider-found' }, h('span', { class: SS.avatarClass('outlook') }, 'M'), h('div', null, h('b', null, found.hostedDomain ? 'Microsoft 365' : 'Microsoft account'), h('span', null, 'A Microsoft sign-in window is open.'))),
        h(
          'ol',
          { class: 'signin-steps' },
          h('li', null, h('span', null, 'Type your password in the Microsoft window and choose Sign in.')),
          h('li', null, h('span', null, 'If it asks whether Quiet Inbox can access your email, choose Accept.')),
          h('li', null, h('span', null, 'The window closes by itself and you’re done.'))
        ),
        status,
        h(
          'p',
          { class: 'hint' },
          'Don’t see the window? ',
          h('button', { class: 'link', type: 'button', onclick: () => reopen('window') }, 'Open it again'),
          ' or ',
          h('button', { class: 'link', type: 'button', onclick: () => reopen('browser') }, 'use your web browser instead'),
          '. Quiet Inbox never sees your Microsoft password.'
        )
      );
      m.setActions([
        {
          label: 'Cancel',
          kind: 'ghost',
          run: async () => {
            attempt++;
            await api('accounts:cancelSignIn').catch(() => {});
            stepEmail();
            return false;
          },
        },
      ]);
      start('window');
    }

    function stepPassword(found) {
      if (found.oauth === 'microsoft') return stepMicrosoft(found);
      const isAppPw = APP_PW.has(found.key);
      const pwLabel = isAppPw ? 'App password' : found.key === 'proton' ? 'Bridge password' : 'Password';
      const pw = h('input', { class: 'input big-input', type: 'password', autocomplete: 'off', spellcheck: 'false', 'aria-label': pwLabel, placeholder: isAppPw ? 'Paste the app password here' : '' });
      const show = h('button', { class: 'btn', type: 'button', onclick: () => ((pw.type = pw.type === 'password' ? 'text' : 'password'), (show.textContent = pw.type === 'password' ? 'Show' : 'Hide')) }, 'Show');
      submitOnEnter(pw);
      const host = h('input', { class: 'input', value: found.host || '', 'aria-label': 'Server' });
      const port = h('input', { class: 'input', type: 'number', value: String(found.port || 993), 'aria-label': 'Port' });
      const security = h('select', { class: 'select', 'aria-label': 'Security' }, [['tls', 'SSL/TLS'], ['starttls', 'STARTTLS'], ['none', 'None']].map(([v, t]) => h('option', { value: v, selected: v === (found.security || 'tls') }, t)));
      const user = h('input', { class: 'input', value: email, 'aria-label': 'Username' });
      const insecure = h('input', { type: 'checkbox', checked: !!found.allowInvalidCert });
      const server = h(
        'details',
        { class: 'server', open: !!found.guessed },
        h('summary', null, found.guessed ? 'Server settings (please check these)' : 'Server settings'),
        h(
          'div',
          { class: 'form-grid' },
          h('label', { class: 'field' }, h('span', null, 'Incoming mail server (IMAP)'), host),
          h('label', { class: 'field' }, h('span', null, 'Port'), port),
          h('label', { class: 'field' }, h('span', null, 'Security'), security),
          h('label', { class: 'field full' }, h('span', null, 'Username'), user),
          h('label', { class: 'check full' }, insecure, h('span', null, 'Allow an untrusted certificate (only for your own server or Proton Bridge)'))
        )
      );
      const name = found.key === 'other' ? 'your email provider' : found.label;
      m.setTitle(`Connect ${email}`);
      m.setBody(
        h('div', { class: 'provider-found' }, h('span', { class: SS.avatarClass(found.key) }, SS.initial(found.label, email)), h('div', null, h('b', null, found.key === 'other' ? email : found.label), h('span', null, found.key === 'other' ? 'We’ll connect with your email password.' : `This is a ${found.label} address.`))),
        found.steps ? h('ol', { class: 'signin-steps' }, found.steps.map((t) => h('li', null, h('span', null, t)))) : null,
        found.hostedDomain && found.key === 'gmail' ? h('p', { class: 'hint' }, 'Work and school accounts sometimes don’t allow app passwords. If the page says so, ask whoever manages the account.') : null,
        found.helpUrl ? h('div', null, h('button', { class: 'btn', type: 'button', onclick: () => api('app:openHelp', found.key) }, SS.icon('external'), found.helpLabel || `Open ${name}`)) : null,
        h('label', { class: 'field' }, h('span', null, pwLabel), h('div', { class: 'pw-row' }, pw, show)),
        server
      );
      m.setActions([
        { label: 'Back', kind: 'ghost', run: () => (stepEmail(), false) },
        {
          label: 'Connect',
          kind: 'primary',
          run: () =>
            api('accounts:add', { email, password: pw.value, preset: found.key, host: host.value, port: port.value, security: security.value, user: user.value, allowInvalidCert: insecure.checked }),
        },
      ]);
      setTimeout(() => pw.focus(), 30);
    }

    stepEmail();
    const acct = await m.result;
    if (acct && acct.id) {
      SS.console.log(`Connected ${acct.email}`, 'ok');
      SS.bus.emit('accounts-changed', { select: acct.id });
    }
    return acct;
  };

  SS.reauthAccount = async (acct) => {
    try {
      await SS.task('Signing in again (a Microsoft window opens)', () => api('accounts:reauth', acct.id, 'window'), { done: `Signed in again as ${acct.email}` });
      SS.bus.emit('accounts-changed', { select: acct.id });
    } catch {
      /* shown in the status bar */
    }
  };

  SS.removeAccount = async (acct) => {
    const ok = await SS.confirm({
      title: `Remove ${acct.email}?`,
      body: [h('p', null, 'Quiet Inbox will forget this account and its blocked senders. Your emails stay exactly where they are.')],
      confirm: 'Remove account',
      danger: true,
    });
    if (!ok) return;
    await api('accounts:remove', acct.id);
    SS.console.log(`Removed ${acct.email}`, 'ok');
    SS.bus.emit('accounts-changed', {});
  };
})();
