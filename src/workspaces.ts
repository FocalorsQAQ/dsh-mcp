import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { DshError } from './types.ts';

export function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

/** Model paths are local paths; drive-relative and device/network paths are ambiguous or not local. */
export function localWorkspacePath(base: string, requested: string): string {
  if (!requested.trim() || requested.includes('\0') || requested.length > 32768 ||
    (process.platform === 'win32' && (/^[\\/]{2}/.test(requested) || /^[a-z]:[^\\/]/i.test(requested) || /^[a-z]:$/i.test(requested)))) {
    throw new DshError('WORKSPACE', 'Specify a local directory path; network, device and drive-relative paths are not supported.');
  }
  const path = resolve(base, requested);
  if (process.platform === 'win32' && /^[\\/]{2}/.test(path)) throw new DshError('WORKSPACE', 'A local directory is required.');
  return path;
}

export function realDirectory(path: string): string {
  try {
    const actual = realpathSync(path);
    if (!statSync(actual).isDirectory()) throw new Error('Not a directory');
    if (process.platform === 'win32' && /^[\\/]{2}/.test(actual)) throw new Error('Not a local directory');
    return actual;
  } catch { throw new DshError('WORKSPACE', 'Directory is unavailable or is not a local directory: ' + path); }
}

export function assertMainWorkspace(path: string, mainRoot?: string): void {
  if (mainRoot && !isWithin(mainRoot, path)) {
    throw new DshError('WORKSPACE_SCOPE', '本轮仅允许主 agent 工作区及其子目录。Workspace must be inside the main-agent workspace: ' + mainRoot);
  }
}

/** Revalidate a persisted root itself, as well as cwd, to catch replaced junctions after registration. */
export function workspaceDirectory(root: string, requested = '.', mainRoot?: string): string {
  if (!isAbsolute(root) || relative(root, realDirectory(root)) !== '') throw new DshError('WORKSPACE', 'The registered workspace moved or was replaced by a link. Register its current location again.');
  assertMainWorkspace(root, mainRoot);
  const path = realDirectory(localWorkspacePath(root, requested));
  if (!isWithin(root, path)) throw new DshError('WORKSPACE', 'Agent cwd must stay inside the selected workspace_root. Use create_workspace and workspace_id for another project.');
  return path;
}

/** Validate the nearest real ancestor before creating anything; never copy or delete project files. */
export function prepareWorkspace(base: string, requested: string, options: { mainRoot?: string; readOnly: boolean }) {
  let ancestor = localWorkspacePath(base, requested);
  const missing: string[] = [];
  for (;;) {
    try { lstatSync(ancestor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) throw new DshError('WORKSPACE', 'Cannot access workspace directory: ' + ancestor);
      missing.unshift(basename(ancestor)); ancestor = dirname(ancestor);
    }
  }
  let path = realDirectory(ancestor);
  assertMainWorkspace(resolve(path, ...missing), options.mainRoot);
  if (missing.length && options.readOnly) throw new DshError('WORKSPACE_READ_ONLY', 'Read-only mode can register an existing directory, but cannot create directories.');
  let created = false;
  for (const part of missing) {
    const next = resolve(path, part);
    assertMainWorkspace(next, options.mainRoot);
    try { mkdirSync(next); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new DshError('WORKSPACE', 'Cannot create workspace directory: ' + next); }
    path = realDirectory(next);
    assertMainWorkspace(path, options.mainRoot);
  }
  return { path, created };
}
