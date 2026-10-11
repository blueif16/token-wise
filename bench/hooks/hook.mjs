// One hook for every event of a benchmark session (wired by bench/lib/agent.mjs).
// - Routes Bash into the task container; keeps host file tools inside the bind-mounted repo.
// - Appends every tool outcome to the task trace.
// - Memory arms: injects team lessons at session start and after a failed tool call.
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { program, signature } from '../lib/signature.mjs';
import { searchLessons } from '../lib/memory.mjs';

const env = process.env;
const input = JSON.parse(readFileSync(0, 'utf8'));
const event = input.hook_event_name;
const memoryOn = env.BENCH_MEMORY && env.BENCH_MEMORY !== 'off';
const maxLookups = Number(env.BENCH_MAX_LOOKUPS || 8);

const shq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const trace = (row) => appendFileSync(env.BENCH_TRACE, JSON.stringify({ ts: Date.now(), ...row }) + '\n');
const reply = (out) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, ...out } }));
const tail = (s, n) => (s && s.length > n ? '…' + s.slice(-n) : s || '');

// Post* events see the routed command; recover what the agent actually typed.
function original(cmd = '') {
  const m = cmd.match(/^docker exec -i \S+ bash -lc '([\s\S]*)'$/);
  return m ? m[1].replace(/'\\''/g, "'").split('\n').slice(1, -1).join('\n') : cmd;
}

function traceRows() {
  try {
    return readFileSync(env.BENCH_TRACE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function lessonsFor(query) {
  const scope = JSON.parse(readFileSync(env.BENCH_SCOPE, 'utf8'));   // [{ id, content_id }]
  const shown = new Set(traceRows().filter((r) => r.kind === 'inject').flatMap((r) => r.content_ids));
  const ids = scope.map((s) => s.content_id).filter((id) => !shown.has(id));
  const hits = searchLessons(query, ids, { max: 2 });
  const byContent = Object.fromEntries(scope.map((s) => [s.content_id, s.id]));
  return hits.map((h) => ({ ...h, id: byContent[h.content_id] }));
}

function inject(hits, why) {
  if (!hits.length) return;
  trace({ kind: 'inject', why, lesson_ids: hits.map((h) => h.id), content_ids: hits.map((h) => h.content_id), scores: hits.map((h) => h.score) });
  reply({
    additionalContext: 'Team memory: lessons other agents on this team learned on earlier tasks. '
      + 'Use them if they fit; check before relying on them.\n\n' + hits.map((h) => h.text).join('\n\n---\n\n'),
  });
}

const FILE_TOOLS = { Read: 'file_path', Edit: 'file_path', Write: 'file_path', NotebookEdit: 'notebook_path', Glob: 'path', Grep: 'path' };

if (event === 'PreToolUse' && input.tool_name === 'Bash') {
  // Bash state does not persist between Claude Code calls, but the working directory does; keep that.
  const inner = `cd "$(cat /tmp/.bench_cwd 2>/dev/null || echo ${shq(env.BENCH_WORKDIR)})" 2>/dev/null\n`
    + `${input.tool_input.command}\n__rc=$?; pwd > /tmp/.bench_cwd; exit $__rc`;
  // Background runs write their output to a file on the host, which the agent (working in the
  // container) cannot read; run them in the foreground with the longest timeout instead.
  const bg = input.tool_input.run_in_background
    ? { run_in_background: false, timeout: Math.max(input.tool_input.timeout || 0, 600_000) } : {};
  if (bg.timeout) trace({ kind: 'foregrounded', command: input.tool_input.command.slice(0, 200) });
  reply({
    permissionDecision: 'allow',
    updatedInput: { ...input.tool_input, ...bg, command: `docker exec -i ${env.BENCH_CONTAINER} bash -lc ${shq(inner)}` },
  });
} else if (event === 'PreToolUse' && FILE_TOOLS[input.tool_name]) {
  const p = input.tool_input[FILE_TOOLS[input.tool_name]];
  if (p && !resolve(input.cwd, p).startsWith(env.BENCH_WORKDIR)) {
    reply({
      permissionDecision: 'deny',
      permissionDecisionReason: `Only ${env.BENCH_WORKDIR} is shared with the task machine. Use Bash for any other path.`,
    });
  }
} else if (event === 'PostToolUse') {
  const r = input.tool_response || {};
  trace({ kind: 'ok', tool: input.tool_name, command: original(input.tool_input?.command), file: input.tool_input?.file_path,
    out: input.tool_name === 'Bash' ? tail(`${r.stdout || ''}${r.stderr ? '\n' + r.stderr : ''}`, 300) : undefined });
} else if (event === 'PostToolUseFailure') {
  const command = original(input.tool_input?.command);
  const sig = signature(input.error);
  trace({ kind: 'fail', tool: input.tool_name, command, file: input.tool_input?.file_path,
    error: tail(input.error, 1500), sig, interrupt: input.is_interrupt || false });
  if (memoryOn && !input.is_interrupt && sig) {
    const looked = traceRows().filter((r) => r.kind === 'lookup');
    if (looked.length < maxLookups && !looked.some((r) => r.sig === sig)) {
      trace({ kind: 'lookup', sig });
      try {
        inject(lessonsFor(`${program(command) || input.tool_name}: ${sig}\n${tail(input.error, 400)}`), 'failure');
      } catch (e) {
        trace({ kind: 'lookup_error', message: String(e.message).slice(0, 300) });
      }
    }
  }
} else if (event === 'SessionStart' && memoryOn) {
  try {
    trace({ kind: 'lookup', sig: 'session-start' });
    inject(lessonsFor(readFileSync(env.BENCH_BRIEF, 'utf8')), 'session-start');
  } catch (e) {
    trace({ kind: 'lookup_error', message: String(e.message).slice(0, 300) });
  }
}
