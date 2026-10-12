// Re-grades finished tasks from their saved patches, e.g. after a grader fix:
//   node bench/regrade.mjs --run deps-pilot-off-s1 --task 2f01c46b96a8      (or --failed)
// The old verdict is kept in the row as `before_regrade`. For memory arms the lessons were
// already decided on the old verdict, so regrade those only to audit, not to rescore.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values: a } = parseArgs({ options: { run: { type: 'string' }, task: { type: 'string' }, failed: { type: 'boolean', default: false } } });
const runDir = resolve('bench/results', a.run);
const file = join(runDir, 'results.jsonl');
const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const adapter = (await import(`./workloads/${rows[0].workload}.mjs`)).default;
if (!adapter.regrade) throw new Error(`${rows[0].workload} has no regrade()`);
const all = [...await adapter.tasks('pilot'), ...await adapter.tasks('full')];

const wanted = (r) => (a.task ? a.task.split(',').includes(r.task) : a.failed && !r.pass);
for (const row of rows.filter(wanted)) {
  const task = all.find((t) => t.id === row.task);
  const check = await adapter.regrade(task, join(runDir, 'tasks', row.task.replace(/[^\w.-]/g, '_')));
  row.before_regrade ??= { pass: row.pass, tampered: row.tampered, check: row.check };
  Object.assign(row, { pass: check.pass, tampered: check.tampered, check: check.detail, regraded_at: new Date().toISOString() });
  console.log(`${row.task}: pass ${row.before_regrade.pass} -> ${row.pass} (attempts ${check.detail.attempts ?? 1})`);
}
writeFileSync(`${file}.tmp`, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
renameSync(`${file}.tmp`, file);
