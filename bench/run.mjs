// Runs one arm of one workload over an ordered task list, carrying memory from task to task.
//   node bench/run.mjs --workload setup --set pilot --arm gated --seed 1
// Arms: off (no memory) · ungated (every lesson kept) · gated (only verified lessons kept).
// Re-running the same command resumes: finished tasks are skipped, the lesson index is kept.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { hookSettings, runAgent } from './lib/agent.mjs';
import { LessonIndex, createFolder, storeLesson } from './lib/memory.mjs';
import { admit, evidence, extract, steps } from './lib/lessons.mjs';
import { signature } from './lib/signature.mjs';

const { values: a } = parseArgs({
  options: {
    workload: { type: 'string' }, set: { type: 'string', default: 'pilot' }, arm: { type: 'string', default: 'off' },
    seed: { type: 'string', default: '1' }, model: { type: 'string', default: 'sonnet' },
    'max-turns': { type: 'string', default: '80' }, 'timeout-min': { type: 'string', default: '30' },
    limit: { type: 'string' }, 'run-id': { type: 'string' }, only: { type: 'string' },
  },
});
if (!['off', 'ungated', 'gated'].includes(a.arm)) throw new Error(`unknown arm ${a.arm}`);

const BENCH_FOLDER = 'a58409f8-1271-419e-a67d-e77de8e539f0';   // Senso folder "bench-memory"
const adapter = (await import(`./workloads/${a.workload}.mjs`)).default;
const runId = a['run-id'] || `${a.workload}-${a.set}-${a.arm}-s${a.seed}`;
const runDir = resolve('bench/results', runId);
mkdirSync(runDir, { recursive: true });
const resultsFile = join(runDir, 'results.jsonl');
const stateFile = join(runDir, 'state.json');
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { runId, args: a };
const index = new LessonIndex(join(runDir, 'lessons.json'));
const settingsFile = hookSettings(join(runDir, 'hooks.settings.json'));
const done = new Set(existsSync(resultsFile)
  ? readFileSync(resultsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).task) : []);

// Same seed, same order in every arm, so arms can be compared task by task.
function shuffled(list, seed) {
  let s = Number(seed) * 2654435761 % 2 ** 32;
  const rnd = () => ((s = (s * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const all = await adapter.tasks(a.set);
const tasks = (adapter.order ? adapter.order(all, a.seed) : shuffled(all, a.seed))
  .filter((t) => !a.only || a.only.split(',').includes(t.id))
  .slice(0, a.limit ? Number(a.limit) : undefined);
console.log(`${runId}: ${tasks.length} tasks, ${done.size} done, ${index.lessons.length} lessons`);

for (const [pos, task] of tasks.entries()) {
  if (done.has(task.id)) continue;
  const taskDir = join(runDir, 'tasks', task.id.replace(/[^\w.-]/g, '_'));
  mkdirSync(taskDir, { recursive: true });
  const traceFile = join(taskDir, 'trace.jsonl');
  writeFileSync(traceFile, '');
  const ctx = { taskDir, container: `tw-${runId}-${pos}`.replace(/[^\w.-]/g, '-').slice(0, 60) };
  const started = Date.now();
  const env = await adapter.prepare(task, ctx);

  const scope = a.arm === 'off' ? [] : index.retrievable(a.arm).map((l) => ({ id: l.id, content_id: l.content_id }));
  writeFileSync(join(taskDir, 'scope.json'), JSON.stringify(scope));
  writeFileSync(join(taskDir, 'brief.txt'), env.brief);

  const run = await runAgent({
    prompt: env.prompt, workdir: env.workdir, container: ctx.container, model: a.model,
    maxTurns: Number(a['max-turns']), timeoutMs: Number(a['timeout-min']) * 60_000, memory: a.arm,
    settingsFile, traceFile, scopeFile: join(taskDir, 'scope.json'), briefFile: join(taskDir, 'brief.txt'),
    logFile: join(taskDir, 'session.jsonl'),
  });
  const agentDone = Date.now();
  if (run.limitHit) {
    await adapter.cleanup(task, ctx);
    console.error(`usage limit hit on ${task.id}; re-run the same command after the reset to resume`);
    process.exit(3);
  }

  const check = await adapter.verify(task, ctx);
  const rows = readFileSync(traceFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const stepList = steps(rows);
  const injected = [...new Set(rows.filter((r) => r.kind === 'inject').flatMap((r) => r.lesson_ids))];

  // Memory bookkeeping happens before the next task starts, so the next task can use it.
  let written = [];
  if (a.arm !== 'off') {
    index.recordUse(injected, check.pass, a.arm);
    for (const lesson of extract({ task: { ...task, brief: env.brief }, passed: check.pass, stepList })) {
      const gate = admit(a.arm, { passed: check.pass, tampered: check.tampered, stepList }, lesson);
      if (!gate.ok) {
        written.push({ rejected: gate.why, when: lesson.when.slice(0, 120) });
        continue;
      }
      const id = `L-${runId}-${index.lessons.length + 1}`;
      const entry = {
        id, workload: a.workload, source_task: task.id, status: a.arm === 'gated' ? 'verified' : 'unverified',
        when: lesson.when, action: lesson.action, evidence: evidence(a.arm, task, gate), uses: 0, passes: 0,
      };
      state.folder ??= createFolder(runId, BENCH_FOLDER);
      Object.assign(entry, storeLesson(entry, state.folder));
      index.lessons.push(entry);
      written.push({ id });
      index.save();
      writeFileSync(stateFile, JSON.stringify(state, null, 2));
    }
  }

  const r = run.result || {};
  const fails = stepList.filter((s) => s.kind === 'fail' && !s.interrupt);
  const row = {
    task: task.id, workload: a.workload, arm: a.arm, seed: Number(a.seed), position: pos, model: a.model,
    pass: check.pass, tampered: check.tampered || false, check: check.detail,
    stop: run.timedOut ? 'timeout' : r.subtype || `exit ${run.exitCode}`,
    turns: r.num_turns ?? null, duration_ms: agentDone - started, agent_ms: r.duration_ms ?? null,
    cost_usd: r.total_cost_usd ?? null,
    tokens: r.usage ? (r.usage.input_tokens || 0) + (r.usage.output_tokens || 0) : null,
    cache_read_tokens: r.usage?.cache_read_input_tokens ?? null,
    tool_calls: stepList.length, failed_calls: fails.length, fail_sigs: fails.map((s) => s.sig || signature(s.error)),
    lookups: rows.filter((x) => x.kind === 'lookup').length, injected, lessons: written,
    lessons_total: index.lessons.length,
  };
  appendFileSync(resultsFile, JSON.stringify(row) + '\n');
  console.log(`[${pos + 1}/${tasks.length}] ${task.id} pass=${row.pass} turns=${row.turns} fails=${row.failed_calls} injected=${injected.length} lessons+${written.filter((w) => w.id).length}`);
  await adapter.cleanup(task, ctx);
}
