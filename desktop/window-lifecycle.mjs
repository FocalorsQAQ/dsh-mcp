import { createRequire } from 'node:module';

let native;
function win32() {
  if (native) return native;
  const koffi = createRequire(import.meta.url)('koffi');
  const user32 = koffi.load('user32.dll');
  native = {
    getOwner: user32.func('uintptr_t __stdcall GetWindow(uintptr_t hwnd, uint32_t command)'),
    setOwner: user32.func('intptr_t __stdcall SetWindowLongPtrW(uintptr_t hwnd, int index, intptr_t value)'),
    getPid: user32.func('uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint32_t *pid)'),
  };
  return native;
}

// Only change the DSH window. Do not restore, hide or activate its external owner.
// Clear the native owner first: Electron's setParentWindow(null) alone hides and
// re-shows a visible Windows window when its native owner changes.
export function detachWindowOwner(window) {
  if (!window || window.isDestroyed()) return;
  if (process.platform === 'win32') {
    const api = win32(), hwnd = window.getNativeWindowHandle().readBigUInt64LE();
    const pid = [0]; api.getPid(hwnd, pid);
    if (pid[0] !== process.pid) throw new Error('Refusing to change another process window.');
    api.setOwner(hwnd, -8, 0);
    if (Number(api.getOwner(hwnd, 4)) !== 0) throw new Error('Could not release the window owner.');
  }
  // Keep Electron's parent/child bookkeeping consistent with Win32.
  window.setParentWindow(null);
}

export async function stopOwnerHelper(helper) {
  if (!helper?.pid || helper.exitCode !== null || helper.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); helper.off('exit', done); helper.off('error', failed); };
    const done = () => { cleanup(); resolve(); };
    const failed = error => { cleanup(); reject(error); };
    const timer = setTimeout(() => failed(new Error('Window owner helper did not stop.')), 5000);
    helper.once('exit', done); helper.once('error', failed);
    helper.kill();
  });
}
