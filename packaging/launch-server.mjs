import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
process.env.PATH = [join(root, 'bin/node'), join(root, 'bin/python'), process.env.PATH ?? ''].join(delimiter);
await import('../dist/cli.js');
