'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = new Set([
  'settings:get', 'settings:set', 'app:info', 'app:msStatus', 'app:theme', 'app:openLink', 'app:openHelp', 'app:openDataFolder',
  'accounts:list', 'accounts:discover', 'accounts:add', 'accounts:addMicrosoft', 'accounts:reauth', 'accounts:cancelSignIn', 'accounts:remove',
  'mail:folders', 'mail:list', 'mail:get', 'mail:markRead', 'mail:trash', 'mail:destroy', 'mail:junk', 'mail:emptyFolder', 'mail:undo',
  'mail:flag', 'mail:folderAction',
  'sender:preview', 'sender:purge', 'sender:previewMany', 'sender:purgeMany',
  'rules:list', 'rules:create', 'rules:delete', 'rules:runNow',
  'analytics:status', 'analytics:scan', 'analytics:getMany', 'analytics:detailMany', 'analytics:olderMany',
  'unsub:get', 'unsub:run', 'activity:list', 'cache:clear',
]);

const EVENTS = new Set(['progress', 'scan', 'rules-ran', 'settings-changed']);

contextBridge.exposeInMainWorld('spamSweep', {
  invoke: (channel, ...args) => (CHANNELS.has(channel) ? ipcRenderer.invoke(channel, ...args) : Promise.reject(new Error(`Blocked channel ${channel}`))),
  on: (event, cb) => {
    if (!EVENTS.has(event)) return () => {};
    const h = (_e, data) => cb(data);
    ipcRenderer.on(event, h);
    return () => ipcRenderer.removeListener(event, h);
  },
  platform: process.platform,
});
