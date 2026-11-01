import { spawn } from 'node:child_process';
import { app, BrowserWindow, ipcMain, screen, safeStorage } from 'electron';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { loadConfig } from '../dist/config.js';
import { UiClient } from '../dist/ui-client.js';
import { settingsCommandSchema, windowIntentSchema } from '../dist/ui-protocol.js';
import { createApiWindow } from './api-window.mjs';
import { createModelWindow } from './model-window.mjs';
import { CredentialRegistry } from '../dist/credentials.js';
import { languages, startupLocale, translate } from './localization.mjs';
import { listSessions, sessionDirectory } from '../dist/sessions.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ args: process.argv.slice(2), options: {
  config: { type: 'string' }, workspace: { type: 'string' }, 'data-dir': { type: 'string' }, 'session-id': { type: 'string' }, 'api-keys': { type: 'boolean' }, models: { type: 'boolean' }, 'auto-start': { type: 'boolean' },
}, strict: false, allowPositionals: true });
const autoStart = values['auto-start'] === true;
const config = loadConfig(values.config ?? (autoStart ? undefined : join(root, 'dsh.config.json')), { workspace: values.workspace, dataDir: values['data-dir'] });
const uiHome = join(config.data_dir, 'desktop');
mkdirSync(uiHome, { recursive: true });
app.setPath('userData', uiHome);
const preferencesPath = join(uiHome, 'window.json');
const rendererPath = join(root, 'dist-ui', 'index.html');
const rendererUrl = pathToFileURL(rendererPath).href;
let preferences = {};
try { preferences = JSON.parse(readFileSync(preferencesPath, 'utf8')); } catch { /* Use defaults. */ }
let locale = startupLocale(process.env.DSH_UI_LOCALE, preferences.locale);
const t = (key, parameters) => translate(locale, key, parameters);
app.setName(t('app.title'));
function savePreferences(next) {
  const temporary = preferencesPath + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
    renameSync(temporary, preferencesPath);
    preferences = next;
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
let window;
let ownerHelper;
let orbWindow;
let orbOwnerHelper;
let floating = false;
let orbDrag;
let panelContentBounds;
let controlClosing = false;
const orbSize = 72;
let compact = false;
let fullHeight = 840;
function readSessions() {
  const entries = listSessions(config.data_dir).map(({ id, workspace, created_at }) => ({ id, workspace, created_at }));
  if (existsSync(join(config.data_dir, 'state.json')) || existsSync(join(config.data_dir, 'ui-endpoint.json'))) {
    entries.push({ id: 'legacy', workspace: config.workspace_root, created_at: '' });
  }
  return entries;
}
let sessions = readSessions();
const preferredSession = values['session-id'] ?? preferences.session_id;
let sessionId = sessions.some(item => item.id === preferredSession) ? preferredSession : sessions[0]?.id ?? 'legacy';
function sessionClient(id) {
  return new UiClient(id === 'legacy' ? config.data_dir : sessionDirectory(config.data_dir, id),
    sessions.find(item => item.id === id)?.workspace ?? config.workspace_root);
}
let client = sessionClient(sessionId);
const state = () => ({ connection: client.snapshot(), session_id: sessionId, sessions, window: { compact, floating } });
const publish = () => { for (const target of [window, orbWindow]) if (target && !target.isDestroyed() && !target.webContents.isLoadingMainFrame()) target.webContents.send('dsh:state', state()); };
let unsubscribeClient = client.subscribe(publish);
function selectSession(id) {
  if (!sessions.some(item => item.id === id)) throw { code: 'UI_SESSION' };
  if (id !== sessionId) {
    unsubscribeClient(); client.close(); sessionId = id; client = sessionClient(id);
    unsubscribeClient = client.subscribe(publish); client.reconnect();
  }
  savePreferences({ ...preferences, session_id: id }); publish(); return state();
}
const catalogTimer = setInterval(() => {
  try {
    const next = readSessions();
    if (JSON.stringify(next) === JSON.stringify(sessions)) return;
    sessions = next;
    if (!sessions.some(item => item.id === sessionId) && sessions.length) selectSession(sessions[0].id);
    else publish();
  } catch { /* A bad entry must not interrupt the selected chat. */ }
}, 1000);
catalogTimer.unref();

function acceptsControl(event) {
  return [window, orbWindow].some(target => target && !target.isDestroyed() && event.sender === target.webContents &&
    event.senderFrame?.url === rendererUrl + (target === orbWindow ? '#orb' : '') && !event.senderFrame.parent);
}
function trusted(event) {
  if (!acceptsControl(event)) {
    throw new Error('Untrusted control sender.');
  }
}
const handler = (name, action) => ipcMain.handle(name, async (event, ...args) => {
  trusted(event);
  try { return { ok: true, value: await action(...args) }; }
  catch (error) { return { ok: false, code: error?.code ?? 'UI_REQUEST', message: friendlyError(error?.code) }; }
});
function friendlyError(code) { return t('error.' + code); }
const modelDirectory = config.model_config_dir ?? config.data_dir;
const credentials = new CredentialRegistry(join(modelDirectory, 'credentials.json'), {
  available: () => process.platform === 'linux' ? Promise.resolve(false) : safeStorage.isAsyncEncryptionAvailable(),
  encrypt: value => safeStorage.encryptStringAsync(value),
  decrypt: async value => (await safeStorage.decryptStringAsync(value)).result,
});
const apiWindow = createApiWindow({ root, registry: credentials, locale: () => locale, translate: t, parent: () => window });
const modelWindow = createModelWindow({ root, dataDir: modelDirectory, credentials, locale: () => locale, translate: t, parent: () => window });

// Language is a local UI preference, independent of the MCP service and provider settings.
const languageHandler = (name, action) => ipcMain.handle(name, (event, ...args) => {
  const fromControl = acceptsControl(event);
  if (!fromControl && !apiWindow.accepts(event) && !modelWindow.accepts(event)) return { ok: false, code: 'FORBIDDEN' };
  try { return { ok: true, value: action(...args) }; }
  catch (error) { return { ok: false, code: error.code ?? 'UI_PREFERENCES' }; }
});
languageHandler('dsh:language:get', () => locale);
languageHandler('dsh:language:set', value => {
  if (typeof value !== 'string' || !Object.hasOwn(languages, value)) throw { code: 'UI_LOCALE' };
  try { savePreferences({ ...preferences, locale: value }); } catch { throw { code: 'UI_PREFERENCES' }; }
  locale = value;
  window?.setTitle(t('app.title'));
  if (window && !window.isDestroyed()) window.webContents.send('dsh:language', locale);
  if (orbWindow && !orbWindow.isDestroyed()) orbWindow.webContents.send('dsh:language', locale);
  apiWindow.languageChanged(locale);
  modelWindow.languageChanged(locale);
  return locale;
});

handler('dsh:state:get', () => state());
handler('dsh:sessions:select', id => selectSession(id));
handler('dsh:settings:update', async (input) => {
  const { session_id, ...settings } = input;
  if (session_id !== undefined && session_id !== sessionId) throw { code: 'UI_SESSION' };
  const command = settingsCommandSchema.parse(settings);
  const target = client;
  await target.updateSettings(command.patch, command.expected_revision); return state();
});
handler('dsh:window:intent', async (input) => {
  const command = windowIntentSchema.parse(input);
  if (command.window === 'api_keys') { await apiWindow.open(); return { window: 'api_keys', implemented: true }; }
  await modelWindow.open(); return { window: 'models', implemented: true };
});
handler('dsh:reconnect', () => { client.reconnect(); return state(); });
function attachOwner(target) {
  if (process.platform !== 'win32') return;
  const hwnd = target.getNativeWindowHandle().readBigUInt64LE().toString();
  const helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(root, 'desktop/owner-window.ps1'), '-WindowHandle', hwnd, '-WindowProcessId', String(process.pid)], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  helper.on('error', error => process.stderr.write('[dsh owner] ' + error.message + '\n'));
  helper.stderr.on('data', data => process.stderr.write(data));
  return helper;
}
function secureContents(target) {
  target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  target.webContents.on('will-navigate', event => event.preventDefault());
  target.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  target.webContents.session.setPermissionCheckHandler(() => false);
}
function orbPosition(point) {
  const display = screen.getDisplayNearestPoint(point).workArea;
  return { x: Math.round(Math.max(display.x, Math.min(point.x, display.x + display.width - orbSize))),
    y: Math.round(Math.max(display.y, Math.min(point.y, display.y + display.height - orbSize))) };
}
async function showOrb() {
  if (floating) return;
  panelContentBounds = window.getContentBounds();
  if (!orbWindow || orbWindow.isDestroyed()) {
    const bounds = window.getBounds();
    const saved = preferences.orb_bounds;
    const point = saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) ? saved : { x: bounds.x + bounds.width - orbSize, y: bounds.y };
    orbWindow = new BrowserWindow({ title: t('app.title'), ...orbPosition(point), width: orbSize, height: orbSize,
      frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, resizable: false,
      maximizable: false, fullscreenable: false, skipTaskbar: true, show: false,
      webPreferences: { additionalArguments: ['--dsh-locale=' + locale], preload: join(root, 'desktop/preload.cjs'),
        contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false },
    });
    orbWindow.removeMenu(); secureContents(orbWindow); orbOwnerHelper = attachOwner(orbWindow);
    orbWindow.on('closed', () => {
      orbOwnerHelper?.kill(); orbWindow = undefined;
      if (floating && !controlClosing && window && !window.isDestroyed()) window.close();
    });
    await orbWindow.loadFile(rendererPath, { hash: 'orb' });
  }
  floating = true; window.hide(); orbWindow.showInactive(); publish();
}
function restoreControl() {
  const fromOrb = floating;
  floating = false; orbDrag = undefined; orbWindow?.hide();
  if (window.isMinimized()) window.restore();
  window.show();
  if (fromOrb && panelContentBounds) window.setContentBounds(panelContentBounds);
  window.focus(); publish();
}
handler('dsh:orb:drag', action => {
  if (!floating || !orbWindow || !['start', 'move', 'end'].includes(action)) return { dragged: false };
  if (action === 'start') orbDrag = { cursor: screen.getCursorScreenPoint(), bounds: orbWindow.getBounds(), dragged: false };
  if (!orbDrag) return { dragged: false };
  if (action === 'move') {
    const cursor = screen.getCursorScreenPoint(), dx = cursor.x - orbDrag.cursor.x, dy = cursor.y - orbDrag.cursor.y;
    if (Math.hypot(dx, dy) >= 4) orbDrag.dragged = true;
    if (orbDrag.dragged) {
      const point = orbPosition({ x: orbDrag.bounds.x + dx, y: orbDrag.bounds.y + dy });
      orbWindow.setPosition(point.x, point.y);
    }
  }
  const dragged = orbDrag.dragged;
  if (action === 'end') {
    if (dragged) { const { x, y } = orbWindow.getBounds(); try { savePreferences({ ...preferences, orb_bounds: { x, y } }); } catch { /* Moving must still work. */ } }
    orbDrag = undefined;
  }
  return { dragged };
});
handler('dsh:window:action', async (action) => {
  if (action === 'compact') {
    if (!compact) fullHeight = window.getBounds().height;
    compact = !compact;
    window.setMinimumSize(400, compact ? 212 : 660);
    window.setSize(window.getBounds().width, compact ? 212 : fullHeight);
  } else if (action === 'minimize') await showOrb();
  else if (action === 'restore') restoreControl();
  else if (action === 'close') window.close();
  else throw new Error('Unknown window action.');
  publish(); return state();
});

if (!app.requestSingleInstanceLock({ autoStart })) app.quit();
else {
  app.on('second-instance', (_event, argv, _directory, additionalData) => {
    // Reconnecting MCP clients must not restore minimized windows or steal focus.
    if (additionalData?.autoStart === true || argv.includes('--auto-start')) return;
    const index = argv.indexOf('--session-id');
    if (index >= 0 && sessions.some(item => item.id === argv[index + 1])) selectSession(argv[index + 1]);
    if (window) { restoreControl(); if (argv.includes('--api-keys')) void apiWindow.open(); if (argv.includes('--models')) void modelWindow.open(); }
  });
  app.whenReady().then(async () => {
    const work = screen.getPrimaryDisplay().workArea;
    const width = Math.min(460, work.width - 32);
    fullHeight = Math.min(840, work.height - 48);
    const saved = preferences.bounds;
    const display = saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) ? screen.getDisplayMatching(saved).workArea : work;
    const x = saved ? Math.min(Math.max(saved.x, display.x), display.x + display.width - width) : work.x + work.width - width - 24;
    const y = saved ? Math.min(Math.max(saved.y, display.y), display.y + display.height - fullHeight) : work.y + 24;
    window = new BrowserWindow({ title: t('app.title'), width, height: fullHeight, x, y,
      minWidth: 400, minHeight: 660, maxWidth: 640, frame: false, show: false, skipTaskbar: true,
      backgroundColor: '#212121', roundedCorners: true, autoHideMenuBar: true,
      webPreferences: { additionalArguments: ['--dsh-locale=' + locale], preload: join(root, 'desktop', 'preload.cjs'), contextIsolation: true,
        nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false },
    });
    window.removeMenu();
    ownerHelper = attachOwner(window);
    secureContents(window);
    window.once('ready-to-show', () => { if (autoStart) window.showInactive(); else window.show(); });
    window.on('close', () => {
      controlClosing = true;
      apiWindow.close();
      modelWindow.close();
      orbWindow?.close();
      const bounds = window.getBounds();
      try { savePreferences({ ...preferences, locale, bounds: { ...bounds, height: fullHeight } }); } catch { /* Window close must still work. */ }
    });
    window.on('closed', () => { ownerHelper?.kill(); window = undefined; });
    await window.loadFile(rendererPath);
    if (values['api-keys']) await apiWindow.open();
    if (values.models) await modelWindow.open();
    client.reconnect();
  }).catch(error => { process.stderr.write('[dsh UI] ' + error.message + '\n'); app.quit(); });
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { clearInterval(catalogTimer); unsubscribeClient(); client.close(); });
