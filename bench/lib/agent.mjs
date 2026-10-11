// Runs one headless Claude Code session on a task. Every arm gets the same flags; only
// BENCH_MEMORY differs. User settings, plugins, MCP servers, CLAUDE.md files, auto memory and
// web tools are all off, so nothing but the arm's lessons can carry over between tasks.
import { spawn } from 'node:child_process';
import { createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../hooks/hook.mjs', import.meta.url));
const LIMIT = /hit your (session|weekly) limit|usage limit/i;

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
    const timer = setTimeout(() => child.kill('SIGTERM'), o.timeoutMs);
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      out.end(() => {
        const rows = readFileSync(o.logFile, 'utf8').split('\n').filter(Boolean).map((l) => {
          try { return JSON.parse(l); } catch { return {}; }
        });
        const result = rows.findLast((r) => r.type === 'result') || null;
        const text = `${result?.result || ''}\n${(result?.errors || []).join('\n')}\n${stderr}`;
        done({ exitCode: code, timedOut: sig === 'SIGTERM', limitHit: LIMIT.test(text), result, stderr: stderr.slice(-2000) });
      });
    });
  });
}
