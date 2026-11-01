#!/usr/bin/env node
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
process.env.PATH = [join(root, 'bin/node'), join(root, 'bin/python'), process.env.PATH ?? ''].join(delimiter);
if (process.argv.some(arg => ['--single-session', '--doctor', '--help', '-h'].includes(arg))) {
  process.argv = process.argv.filter(arg => arg !== '--single-session');
  await import('../dist/cli.js');
} else {
  const { multiClientMain } = await import('../dist/multi-client.js');
  await multiClientMain();
}
