// Summarises finished runs: node bench/report.mjs [--workload setup] [--json]
// "Repeat failure" = a failed call whose signature already failed in an earlier task of the same run:
// the team paying twice for a problem it had already met.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: a } = parseArgs({ options: { workload: { type: 'string' }, json: { type: 'boolean', default: false } } });
const ROOT = 'bench/results';

const runs = (existsSync(ROOT) ? readdirSync(ROOT) : []).map((id) => {
  const f = join(ROOT, id, 'results.jsonl');
  if (!existsSync(f)) return null;
  const rows = readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).sort((x, y) => x.position - y.position);
  const lessonsFile = join(ROOT, id, 'lessons.json');
  const lessons = existsSync(lessonsFile) ? JSON.parse(readFileSync(lessonsFile, 'utf8')) : [];
  return rows.length ? { id, rows, lessons } : null;
}).filter((r) => r && (!a.workload || r.rows[0].workload === a.workload));

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const pct = (x) => `${(100 * x).toFixed(0)}%`;

function summarise(run) {
  const seen = new Set();
  let repeats = 0;
  let fails = 0;
  for (const r of run.rows) {
    const sigs = r.fail_sigs.filter(Boolean);
    fails += sigs.length;
    repeats += sigs.filter((s) => seen.has(s)).length;
    sigs.forEach((s) => seen.add(s));
  }
  const half = Math.floor(run.rows.length / 2);
  const rejected = run.rows.flatMap((r) => r.lessons.filter((l) => l.rejected));
  return {
    run: run.id, workload: run.rows[0].workload, arm: run.rows[0].arm, seed: run.rows[0].seed, tasks: run.rows.length,
    pass_rate: mean(run.rows.map((r) => +r.pass)),
    pass_rate_second_half: mean(run.rows.slice(half).map((r) => +r.pass)),
    failed_calls_per_task: mean(run.rows.map((r) => r.failed_calls)),
    repeat_failures_per_task: repeats / run.rows.length,
    repeat_share: fails ? repeats / fails : 0,
    tool_calls_per_task: mean(run.rows.map((r) => r.tool_calls)),
    turns_per_task: mean(run.rows.map((r) => r.turns || 0)),
    minutes_per_task: mean(run.rows.map((r) => r.duration_ms / 60_000)),
    est_cost_usd: run.rows.reduce((s, r) => s + (r.cost_usd || 0), 0),
    tampered: run.rows.filter((r) => r.tampered).length,
    tasks_with_injection: mean(run.rows.map((r) => +(r.injected.length > 0))),
    lessons_stored: run.lessons.length,
    lessons_rejected_by_gate: rejected.length,
    lessons_retired: run.lessons.filter((l) => l.status === 'retired').length,
  };
}

// Same workload and seed: which tasks did this arm pass that memory-off failed, and the reverse.
function paired(run) {
  const base = runs.find((r) => r.rows[0].workload === run.rows[0].workload && r.rows[0].seed === run.rows[0].seed && r.rows[0].arm === 'off');
  if (!base || base === run) return null;
  const off = Object.fromEntries(base.rows.map((r) => [r.task, r.pass]));
  const both = run.rows.filter((r) => r.task in off);
  return {
    vs_off_tasks: both.length,
    wins: both.filter((r) => r.pass && !off[r.task]).map((r) => r.task),
    losses: both.filter((r) => !r.pass && off[r.task]).map((r) => r.task),
  };
}

const out = runs.map((r) => ({ ...summarise(r), ...paired(r) }));
if (a.json) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log('| run | tasks | pass | pass 2nd half | failed calls/task | repeat failures/task | repeat share | min/task | tampered | lessons (stored/rejected/retired) | wins/losses vs off |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const s of out) {
    console.log(`| ${s.run} | ${s.tasks} | ${pct(s.pass_rate)} | ${pct(s.pass_rate_second_half)} | ${s.failed_calls_per_task.toFixed(1)} | ${s.repeat_failures_per_task.toFixed(1)} | ${pct(s.repeat_share)} | ${s.minutes_per_task.toFixed(1)} | ${s.tampered} | ${s.lessons_stored}/${s.lessons_rejected_by_gate}/${s.lessons_retired} | ${s.wins ? `${s.wins.length}/${s.losses.length}` : '—'} |`);
  }
}
