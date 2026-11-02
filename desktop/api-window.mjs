import { BrowserWindow, ipcMain, screen } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { detachWindowOwner } from './window-lifecycle.mjs';

export function createApiWindow({ root, registry, locale, translate, parent }) {
  let window;
  const renderer = join(root, 'dist-ui/index.html');
  const url = pathToFileURL(renderer).href + '#api-keys';
  const accepts = event => !!window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame?.url === url && !event.senderFrame.parent;
  const handle = (name, action) => ipcMain.handle(name, async (event, input) => {
    if (!accepts(event))
      return { ok: false, code: 'FORBIDDEN' };
    try { return { ok: true, value: await action(input) }; }
    catch (error) { return { ok: false, code: error?.name === 'ZodError' ? 'API_INPUT' : error?.code ?? 'API_STORAGE' }; }
  });
  handle('dsh:apis:list', () => registry.list());
  handle('dsh:apis:add', input => registry.add(input));
  handle('dsh:apis:update', input => registry.update(input));
  handle('dsh:apis:remove', input => registry.remove(input));
  handle('dsh:apis:close', () => { window.close(); });
  return {
    accepts,
    languageChanged(value) {
      if (window && !window.isDestroyed()) { window.setTitle(translate('api.title')); window.webContents.send('dsh:language', value); }
    },
    async open() {
      if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); return; }
      const owner = parent();
      const area = screen.getDisplayMatching(owner.getBounds()).workArea;
      window = new BrowserWindow({ parent: owner, width: Math.min(760, area.width - 40), height: Math.min(730, area.height - 40),
        minWidth: 600, minHeight: 500, frame: false, show: false, skipTaskbar: true, minimizable: false,
        title: translate('api.title'), backgroundColor: '#212121', autoHideMenuBar: true,
        webPreferences: { preload: join(root, 'desktop/preload.cjs'), additionalArguments: ['--dsh-locale=' + locale()],
          contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false } });
      window.removeMenu();
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      window.webContents.session.setPermissionCheckHandler(() => false);
      window.once('ready-to-show', () => window.show());
      window.on('close', () => detachWindowOwner(window));
      window.on('closed', () => { window = undefined; });
      await window.loadFile(renderer, { hash: 'api-keys' });
    },
    close() { window?.close(); },
  };
}
