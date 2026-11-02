const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('dsh', {
  locale: process.argv.find(value => value.startsWith('--dsh-locale='))?.slice(13) ?? 'zh-CN',
  language: {
    get: () => ipcRenderer.invoke('dsh:language:get'),
    set: value => ipcRenderer.invoke('dsh:language:set', value),
    subscribe: listener => {
      const wrapped = (_event, value) => listener(value);
      ipcRenderer.on('dsh:language', wrapped);
      return () => ipcRenderer.removeListener('dsh:language', wrapped);
    },
  },
  apis: {
    list: () => ipcRenderer.invoke('dsh:apis:list'),
    add: input => ipcRenderer.invoke('dsh:apis:add', input),
    update: input => ipcRenderer.invoke('dsh:apis:update', input),
    remove: input => ipcRenderer.invoke('dsh:apis:remove', input),
    close: () => ipcRenderer.invoke('dsh:apis:close'),
  },
  models: {
    list: () => ipcRenderer.invoke('dsh:models:list'),
    save: input => ipcRenderer.invoke('dsh:models:save', input),
    toggle: input => ipcRenderer.invoke('dsh:models:toggle', input),
    remove: input => ipcRenderer.invoke('dsh:models:remove', input),
    verify: input => ipcRenderer.invoke('dsh:models:verify', input),
    close: () => ipcRenderer.invoke('dsh:models:close'),
  },
  getState: () => ipcRenderer.invoke('dsh:state:get'),
  setOutsourcingEnabled: (enabled, expected_revision) => ipcRenderer.invoke('dsh:outsourcing:set', { enabled, expected_revision }),
  updateSettings: (patch, revision) => ipcRenderer.invoke('dsh:settings:update', { patch, expected_revision: revision }),
  openManagementWindow: window => ipcRenderer.invoke('dsh:window:intent', { window }),
  reconnect: () => ipcRenderer.invoke('dsh:reconnect'),
  windowAction: action => ipcRenderer.invoke('dsh:window:action', action),
  subscribe: listener => {
    const wrapped = (_event, value) => listener(value);
    ipcRenderer.on('dsh:state', wrapped);
    return () => ipcRenderer.removeListener('dsh:state', wrapped);
  },
});
