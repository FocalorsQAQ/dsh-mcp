import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';

// Inject a desktop-only failure into the real MCP entry point, without launching a UI.
const original = childProcess.spawn;
childProcess.spawn = function (command, ...args) {
  if (/^electron(?:\.exe)?$/i.test(basename(command))) throw new Error('Simulated control window launch failure');
  return original.call(this, command, ...args);
};
syncBuiltinESMExports();
