import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' });
if (result.status !== 0) throw new Error('Cannot inventory publication files.');
const files = [...new Set(result.stdout.split('\0').filter(Boolean))];
const issues = [];
const localPaths = [process.cwd(), process.env.USERPROFILE].filter(Boolean).flatMap(path => [path, path.replaceAll('\\', '/'), path.replaceAll('\\', '\\\\')]);
for (const path of files) {
  if (/^(?:\.env(?:\.|$)|\.dsh-mcp\/|\.test-output\/|node_modules\/|upstream\/|\.release(?:-cache)?\/|release-output\/)/.test(path) && path !== '.env.example') issues.push({ path, issue:'excluded local data' });
  const buffer = readFileSync(path);
  if (buffer.length > 5 * 1024 * 1024) { issues.push({ path, issue:'large source artifact' }); continue; }
  const text = buffer.toString('utf8');
  if (/sk-(?:proj-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) issues.push({ path, issue:'possible credential' });
  if (localPaths.some(local => text.includes(local))) issues.push({path, issue:'local personal path'});
}
// Print file names and classifications only, never the matching content.
console.log(JSON.stringify({ files:files.length, issues }, null, 2));
if (issues.length) process.exitCode = 1;
