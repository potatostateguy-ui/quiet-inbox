'use strict';

(() => {
  const { api } = SS;
  const views = {};

  SS.saveSetting = async (key, value) => {
    SS.state.settings = await api('settings:set', { [key]: value });
    return SS.state.settings;
  };

  SS.selectAccount = (id) => {
    SS.state.accountId = id;
    SS.bus.emit('account', id);
  };

  SS.show = (view) => {
    SS.closeMenu();
    SS.state.view = view;
    for (const t of document.querySelectorAll('.tab')) t.setAttribute('aria-selected', String(t.dataset.view === view));
    for (const k of Object.keys(views)) document.getElementById(`view-${k}`).hidden = k !== view;
    views[view]?.onShow?.();
  };

  async function boot() {
    SS.console.init(document.getElementById('console'));
    SS.state.settings = await api('settings:get');
    SS.applyTheme(SS.state.settings.theme || 'light');
    SS.state.accounts = await api('accounts:list');
    SS.state.accountId = SS.state.accounts[0]?.id || null;

    Object.assign(views, { mail: SS.Mail, analytics: SS.Cleanup, rules: SS.Blocked, settings: SS.Settings });
    for (const [k, v] of Object.entries(views)) v.mount(document.getElementById(`view-${k}`));
    for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => SS.show(t.dataset.view));

    SS.on('progress', (d) => SS.console.log(d.text, d.error ? 'error' : 'info', { busy: !!d.busy }));
    SS.on('scan', (d) => SS.bus.emit('scan', d));
    SS.on('rules-ran', (d) => SS.bus.emit('rules-ran', d));
    SS.on('settings-changed', (st) => {
      SS.state.settings = st;
      if (SS.state.view === 'settings') SS.Settings.onShow();
    });

    SS.bus.on('accounts-changed', async ({ select } = {}) => {
      SS.state.accounts = await api('accounts:list');
      const keep = SS.state.accounts.find((a) => a.id === (select || SS.state.accountId));
      SS.selectAccount(keep ? keep.id : SS.state.accounts[0]?.id || null);
    });

    SS.actions.refreshFreed();
    if (!SS.state.accounts.length) SS.console.log('Welcome. Add your email account to get started.');
  }

  boot().catch((e) => SS.console.log(`Quiet Inbox couldn’t start: ${e.message}`, 'error'));
})();
