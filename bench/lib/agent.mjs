// Runs one headless Claude Code session on a task. Every arm gets the same flags; only
// BENCH_MEMORY differs. User settings, plugins, MCP servers, CLAUDE.md files, auto memory and
// web tools are all off, so nothing but the arm's lessons can carry over between tasks.
import { spawn } from 'node:child_process';
import { createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../hooks/hook.mjs', import.meta.url));
const LIMIT = /hit your (session|weekly) limit|usage limit/i;

// One session can emit several result messages (each time the agent resumes). Turns, time and
// tokens are per segment; cost is already a running total (measured 2026-10-11).
export function totals(results) {
  if (!results.length) return null;
  const last = results.at(-1);
  const sum = (f) => results.reduce((n, r) => n + (f(r) || 0), 0);
  return {
    ...last,
    segments: results.length,
    num_turns: sum((r) => r.num_turns),
    duration_ms: sum((r) => r.duration_ms),
    total_cost_usd: Math.max(...results.map((r) => r.total_cost_usd || 0)),
    usage: {
      input_tokens: sum((r) => r.usage?.input_tokens),
      output_tokens: sum((r) => r.usage?.output_tokens),
      cache_read_input_tokens: sum((r) => r.usage?.cache_read_input_tokens),
      cache_creation_input_tokens: sum((r) => r.usage?.cache_creation_input_tokens),
    },
  };
}

export function hookSettings(path) {
  const cmd = { type: 'command', command: `node ${HOOK}`, timeout: 60 };
  writeFileSync(path, JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [cmd] }],
      PreToolUse: [{ matcher: 'Bash|Read|Edit|Write|NotebookEdit|Glob|Grep', hooks: [cmd] }],
      PostToolUse: [{ matcher: '*', hooks: [cmd] }],
      PostToolUseFailure: [{ matcher: '*', hooks: [cmd] }],
    },
  }, null, 2));
  return path;
}

export function runAgent(o) {
  const args = ['-p', o.prompt,
    '--model', o.model,
    '--max-turns', String(o.maxTurns),
    '--setting-sources', '',
    '--settings', o.settingsFile,
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--disallowedTools', 'WebSearch', 'WebFetch',
    '--no-session-persistence',
    '--permission-mode', 'acceptEdits',
    '--output-format', 'stream-json', '--verbose'];
  const env = {
    ...process.env,
    BENCH_MEMORY: o.memory, BENCH_CONTAINER: o.container, BENCH_WORKDIR: o.workdir,
    BENCH_TRACE: o.traceFile, BENCH_SCOPE: o.scopeFile, BENCH_BRIEF: o.briefFile,
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
  };
  return new Promise((done) => {
    const out = createWriteStream(o.logFile);
    const child = spawn('claude', args, { cwd: o.workdir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.pipe(out);
    child.stderr.on('data', (d) => { stderr += d; });
    // Claude exits cleanly on SIGTERM, so the timeout is known from our own flag, not the signal.
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, o.timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      out.end(() => {
        const rows = readFileSync(o.logFile, 'utf8').split('\n').filter(Boolean).map((l) => {
          try { return JSON.parse(l); } catch { return {}; }
        });
        const result = totals(rows.filter((r) => r.type === 'result'));
        const text = `${result?.result || ''}\n${(result?.errors || []).join('\n')}\n${stderr}`;
        done({ exitCode: code, timedOut, limitHit: LIMIT.test(text), result, stderr: stderr.slice(-2000) });
      });
    });
  });
}
