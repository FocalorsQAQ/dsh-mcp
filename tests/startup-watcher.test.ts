import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

test('desktop startup detection, lifecycle, retry and owned registration', () => {
  const result = spawnSync('python', ['-I', '-B', resolve('tests/python/test_codex_watch.py')], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
