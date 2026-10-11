// Checks that every task in a set is fair before any agent runs on it:
//   node bench/validate.mjs --workload sec --set pilot
// Results go to bench/workloads/<workload>.valid.json; invalid tasks are dropped from all arms.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values: a } = parseArgs({ options: { workload: { type: 'string' }, set: { type: 'string', default: 'pilot' } } });
const adapter = (await import(`./workloads/${a.workload}.mjs`)).default;
if (!adapter.validate) throw new Error(`${a.workload} has no validate()`);

const file = resolve(`bench/workloads/${a.workload}.valid.json`);
const valid = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
// tasks() hides invalid tasks; re-checking needs the full list, so read it before filtering.
const tasks = await adapter.tasks(a.set);
for (const task of tasks) {
  if (task.id in valid) continue;
  const taskDir = resolve('bench/.work/validate', a.workload, task.id.replace(/[^\w.-]/g, '_'));
  mkdirSync(taskDir, { recursive: true });
  const t0 = Date.now();
  try {
    valid[task.id] = await adapter.validate(task, { taskDir, container: `tw-validate-${task.id}`.replace(/[^\w.-]/g, '-').slice(0, 60) });
  } catch (e) {
    valid[task.id] = { ok: false, why: `validation error: ${String(e.message).slice(0, 300)}` };
  }
  writeFileSync(file, JSON.stringify(valid, null, 2));
  console.log(`${task.id} ok=${valid[task.id].ok} ${valid[task.id].why} (${Math.round((Date.now() - t0) / 1000)}s)`);
}
const ids = tasks.map((t) => t.id);
console.log(`${ids.filter((id) => valid[id]?.ok).length}/${ids.length} valid`);
