import assert from 'node:assert/strict';
import { test } from 'node:test';
import { program, signature } from '../lib/signature.mjs';
import { admit, digest, steps } from '../lib/lessons.mjs';
import { LessonIndex } from '../lib/memory.mjs';

test('same root cause in different repos gives the same signature', () => {
  const a = signature('Exit code 1\nCollecting psycopg2==2.9.5\n  error: command \'/usr/bin/gcc\' failed with exit code 1\nERROR: Failed building wheel for psycopg2');
  const b = signature('Exit code 1\nCollecting psycopg2==2.9.9\n  error: command \'/usr/bin/gcc\' failed with exit code 1\nERROR: Failed building wheel for psycopg2');
  assert.equal(a, b);
  assert.notEqual(a, signature('Exit code 127\nbash: line 2: mvn: command not found'));
});

test('signature masks paths, numbers and hashes', () => {
  assert.equal(signature('fatal: /srv/app/repo/.git/index.lock exists 3f2a9c1d'), 'fatal: <path> exists <hex>');
});

test('program skips sudo and env assignments', () => {
  assert.equal(program('sudo DEBIAN_FRONTEND=noninteractive apt-get install -y gcc'), 'apt-get');
  assert.equal(program('/usr/local/bin/pip install x'), 'pip');
});

const rows = [
  { kind: 'ok', tool: 'Bash', command: 'ls' },
  { kind: 'fail', tool: 'Bash', command: 'pip install psycopg2', error: 'Failed building wheel', sig: 'x' },
  { kind: 'lookup', sig: 'x' },
  { kind: 'ok', tool: 'Bash', command: 'apt-get install -y libpq-dev' },
];

test('steps number only tool outcomes', () => {
  assert.deepEqual(steps(rows).map((s) => [s.n, s.kind]), [[1, 'ok'], [2, 'fail'], [3, 'ok']]);
  assert.match(digest(steps(rows)), /\[2\] FAIL \$ pip install psycopg2/);
});

test('gated admission needs a pass, untouched tests, and a later fix of a real failure', () => {
  const stepList = steps(rows);
  const good = { failure_step: 2, fix_step: 3 };
  assert.equal(admit('gated', { passed: true, tampered: false, stepList }, good).ok, true);
  assert.equal(admit('gated', { passed: false, tampered: false, stepList }, good).ok, false);
  assert.equal(admit('gated', { passed: true, tampered: true, stepList }, good).ok, false);
  assert.equal(admit('gated', { passed: true, tampered: false, stepList }, { failure_step: 1, fix_step: 3 }).ok, false);
  assert.equal(admit('gated', { passed: true, tampered: false, stepList }, { failure_step: 2, fix_step: 1 }).ok, false);
  assert.equal(admit('ungated', { passed: false, tampered: true, stepList }, { failure_step: 9, fix_step: 0 }).ok, true);
  const silent = steps([{ kind: 'fail', tool: 'Bash', command: 'grep x f', error: 'Exit code 1', sig: '' }, { kind: 'ok', tool: 'Bash' }]);
  assert.equal(admit('gated', { passed: true, tampered: false, stepList: silent }, { failure_step: 1, fix_step: 2 }).why, 'cited failure has no error message');
});

test('gated memory retires a lesson shown three times without a pass; ungated keeps it', () => {
  for (const arm of ['gated', 'ungated']) {
    const idx = new LessonIndex('/nonexistent/lessons.json');
    idx.lessons = [{ id: 'L1', status: arm === 'gated' ? 'verified' : 'unverified', uses: 0, passes: 0 }];
    for (let i = 0; i < 3; i++) idx.recordUse(['L1'], false, arm);
    assert.equal(idx.retrievable(arm).length, arm === 'gated' ? 0 : 1);
  }
});
