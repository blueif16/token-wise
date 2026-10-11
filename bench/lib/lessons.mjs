// Turns a finished task's trace into lessons, then applies the arm's admission rule:
//   ungated: every extracted lesson is stored (how most agent memory works today);
//   gated:   a lesson is stored only if the task passed its official check without tampering,
//            and the trace shows the failure it names followed by the step that resolved it.
import { spawnSync } from 'node:child_process';

const SCHEMA = {
  type: 'object',
  properties: {
    lessons: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          when: { type: 'string', description: 'The error text or situation a future agent will see. Short, literal.' },
          action: { type: 'string', description: 'What to do instead, as concrete commands or edits.' },
          failure_step: { type: 'integer', description: 'Step number of the FAIL this lesson addresses.' },
          fix_step: { type: 'integer', description: 'Step number of the OK step that resolved it.' },
        },
        required: ['when', 'action', 'failure_step', 'fix_step'],
      },
    },
  },
  required: ['lessons'],
};

const clip = (s = '', n) => (s.length > n ? s.slice(0, n) + '…' : s);

// Numbered steps the extractor can cite, and the gate can check.
export function steps(rows) {
  return rows.filter((r) => r.kind === 'ok' || r.kind === 'fail').map((r, i) => ({ n: i + 1, ...r }));
}

export function digest(stepList, max = 14_000) {
  const line = (s) => {
    const what = s.command ? `$ ${clip(s.command, 300)}` : `${s.tool} ${s.file || ''}`;
    return s.kind === 'fail'
      ? `[${s.n}] FAIL ${what}\n      error: ${clip((s.error || '').split('\n').slice(-8).join(' | '), 500)}`
      : `[${s.n}] OK   ${what}`;
  };
  let text = stepList.map(line).join('\n');
  if (text.length > max) text = text.slice(0, max / 2) + '\n[… middle of trace omitted …]\n' + text.slice(-max / 2);
  return text;
}

export function extract({ task, passed, stepList, model = 'haiku' }) {
  if (!stepList.some((s) => s.kind === 'fail')) return [];
  const prompt = [
    'You review one coding agent session and write lessons for teammates\' agents, who will work on',
    'DIFFERENT repositories and tasks of the same kind. A lesson names a failure the agent hit and what',
    'got it past that failure. Keep only lessons that would save a future agent real time elsewhere;',
    'skip anything specific to this one repository. Return at most 3; return none if nothing qualifies.',
    '',
    `Task kind: ${task.kind}`,
    `Task: ${clip(task.brief, 1500)}`,
    `Official check after the session: ${passed ? 'PASSED' : 'FAILED'}`,
    '',
    'Steps:',
    digest(stepList),
  ].join('\n');
  const res = spawnSync('claude', ['-p', prompt, '--model', model, '--json-schema', JSON.stringify(SCHEMA),
    '--output-format', 'json', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--tools', '', '--no-session-persistence', '--max-turns', '3'],
  { encoding: 'utf8', timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } });
  try {
    return JSON.parse(res.stdout).structured_output?.lessons || [];
  } catch {
    return [];
  }
}

export function admit(arm, { passed, tampered, stepList }, lesson) {
  if (arm === 'ungated') return { ok: true };
  if (!passed) return { ok: false, why: 'task failed its official check' };
  if (tampered) return { ok: false, why: 'tests or checks were tampered with' };
  const fail = stepList.find((s) => s.n === lesson.failure_step);
  const fix = stepList.find((s) => s.n === lesson.fix_step);
  if (!fail || fail.kind !== 'fail') return { ok: false, why: 'cited failure is not a failed step' };
  // A bare non-zero exit (grep with no match, a test -f) is not an error worth a lesson.
  if (!fail.sig) return { ok: false, why: 'cited failure has no error message' };
  if (!fix || fix.kind !== 'ok' || fix.n <= fail.n) return { ok: false, why: 'cited fix is not a later successful step' };
  return { ok: true, fail, fix };
}

export function evidence(arm, task, proof) {
  if (arm !== 'gated') return `Seen in task ${task.id}.`;
  return [
    `Verified: task ${task.id} passed its official check with tests untouched.`,
    `Failure (step ${proof.fail.n}): \`${clip(proof.fail.command || proof.fail.tool, 200)}\` → ${proof.fail.sig}`,
    `Resolved by (step ${proof.fix.n}): \`${clip(proof.fix.command || `${proof.fix.tool} ${proof.fix.file || ''}`, 300)}\``,
  ].join('\n');
}
