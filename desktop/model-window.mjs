import { BrowserWindow, ipcMain, dialog, screen } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ModelRegistry } from '../dist/model-config.js';
import { detachWindowOwner } from './window-lifecycle.mjs';

export function createModelWindow({ root, dataDir, credentials, locale, translate: t, parent }) {
  let window, verifying = false;
  const renderer = join(root, 'dist-ui/index.html'), url = pathToFileURL(renderer).href + '#models';
  const accepts = event => !!window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame?.url === url && !event.senderFrame.parent;
  const registry = new ModelRegistry(join(dataDir, 'model-config.json'), credentials);
  const handle = (name, action) => ipcMain.handle(name, async (event, input) => {
    if (!accepts(event)) return { ok: false, code: 'FORBIDDEN' };
    try { return { ok: true, value: await action(input) }; }
    catch (error) { return { ok: false, code: error?.name === 'ZodError' ? 'MODEL_INPUT' : error?.code ?? 'MODEL_STORAGE' }; }
  });
  handle('dsh:models:list', () => registry.list());
  handle('dsh:models:save', input => registry.save(input));
  handle('dsh:models:toggle', input => registry.toggle(input));
  handle('dsh:models:remove', input => registry.remove(input));
  handle('dsh:models:close', () => window.close());
  handle('dsh:models:verify', async input => {
    if (verifying) throw { code: 'MODEL_BUSY' };
    verifying = true;
    try {
      const plan = await registry.prepare(input);
      const response = await dialog.showMessageBox(window, { type: 'question', title: t('model.confirmTitle'),
        message: t('model.confirmCost'), detail: [t('api.name') + ': ' + plan.api_name, t('api.protocol') + ': ' + t('protocol.' + plan.protocol), t('model.id') + ': ' + plan.draft.model_id,
          t('api.baseUrl') + ': ' + plan.base_url, t('model.verifyReasoning') + ': ' + (plan.reasoning ?? t('model.noReasoning')),
          t('model.outputLimit') + ': ' + plan.output_limit, t('model.confirmDetail')].join('\n'),
        buttons: [t('model.confirmYes'), t('api.cancel')], defaultId: 1, cancelId: 1, noLink: true });
      if (response.response !== 0 || !window) { registry.cancel(plan.token); return { cancelled: true }; }
      return { cancelled: false, ...await registry.confirm(plan.token) };
    } finally { verifying = false; }
  });
  return {
    accepts,
    languageChanged(value) {
      if (window && !window.isDestroyed()) { window.setTitle(t('model.title')); window.webContents.send('dsh:language', value); }
    },
    async open() {
      if (window && !window.isDestroyed()) { window.show(); window.focus(); return; }
      const owner = parent(), area = screen.getDisplayMatching(owner.getBounds()).workArea;
      window = new BrowserWindow({ parent: owner, width: Math.min(920, area.width - 40), height: Math.min(750, area.height - 40),
        minWidth: 720, minHeight: 520, frame: false, skipTaskbar: true, minimizable: false, show: false, title: t('model.title'), backgroundColor: '#212121',
        webPreferences: { preload: join(root, 'desktop/preload.cjs'), additionalArguments: ['--dsh-locale=' + locale()],
          contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false } });
      window.removeMenu(); window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.webContents.session.setPermissionRequestHandler((_c, _p, callback) => callback(false));
      window.webContents.session.setPermissionCheckHandler(() => false);
      window.once('ready-to-show', () => window.show());
      window.on('close', () => detachWindowOwner(window));
      window.on('closed', () => { registry.close(); window = undefined; });
      await window.loadFile(renderer, { hash: 'models' });
    },
    close() { registry.close(); window?.close(); },
  };
}
