const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('q9', {
  isElectron: true,
  version: '1.2.0',
  data: {
    get: () => ipcRenderer.invoke('data:get'),
    set: (data) => ipcRenderer.invoke('data:set', data),
  },
  system: {
    info: () => ipcRenderer.invoke('system:info'),
  },
  shell: {
    open: (url) => ipcRenderer.invoke('shell:open', { url }),
    openInternal: (payload) => ipcRenderer.invoke('shell:openInternal', payload),
  },
  webhook: {
    send: (payload) => ipcRenderer.invoke('webhook:send', payload),
  },
  logs: {
    get: (gid) => ipcRenderer.invoke('logs:get', gid),
    append: (gid, entries) => ipcRenderer.invoke('logs:append', { gid, entries }),
    clear: (gid) => ipcRenderer.invoke('logs:clear', gid),
  },
  token: {
    check: (token) => ipcRenderer.invoke('token:check', token),
  },
  server: {
    info: (payload) => ipcRenderer.invoke('server:info', payload),
  },
  bot: {
    me: (payload) => ipcRenderer.invoke('bot:me', payload),
  },
  channels: {
    list: (payload) => ipcRenderer.invoke('channels:list', payload),
  },
  channel: {
    messages: (payload) => ipcRenderer.invoke('channel:messages', payload),
    send: (payload) => ipcRenderer.invoke('channel:send', payload),
  },
  reaction: {
    add: (payload) => ipcRenderer.invoke('reaction:add', payload),
    remove: (payload) => ipcRenderer.invoke('reaction:remove', payload),
  },
  user: {
    profile: (payload) => ipcRenderer.invoke('user:profile', payload),
  },
  guild: {
    roles: (payload) => ipcRenderer.invoke('guild:roles', payload),
  },
  boost: {
    run: (payload) => ipcRenderer.invoke('boost:run', payload),
    transfer: (payload) => ipcRenderer.invoke('boost:transfer', payload),
    onLog: (cb) => {
      const listener = (_e, data) => cb(data);
      ipcRenderer.on('boost:log', listener);
      return () => ipcRenderer.removeListener('boost:log', listener);
    },
  },
  decorate: {
    run: (payload) => ipcRenderer.invoke('decorate:run', payload),
    one: (payload) => ipcRenderer.invoke('decorate:one', payload),
    onLog: (cb) => {
      const listener = (_e, data) => cb(data);
      ipcRenderer.on('decorate:log', listener);
      return () => ipcRenderer.removeListener('decorate:log', listener);
    },
  },
  joiner: {
    join: (payload) => ipcRenderer.invoke('joiner:join', payload),
  },
  profile: {
    snapshot: (payload) => ipcRenderer.invoke('profile:snapshot', payload),
    restore: (payload) => ipcRenderer.invoke('profile:restore', payload),
  },
  member: {
    leave: (payload) => ipcRenderer.invoke('member:leave', payload),
  },
  invite: {
    create: (payload) => ipcRenderer.invoke('invite:create', payload),
  },
  presence: {
    set: (payload) => ipcRenderer.invoke('presence:set', payload),
    setMany: (payload) => ipcRenderer.invoke('presence:setMany', payload),
    stop: (payload) => ipcRenderer.invoke('presence:stop', payload),
    state: () => ipcRenderer.invoke('presence:state'),
    onUpdate: (cb) => {
      const listener = (_e, data) => cb(data);
      ipcRenderer.on('presence:update', listener);
      return () => ipcRenderer.removeListener('presence:update', listener);
    },
  },
});
