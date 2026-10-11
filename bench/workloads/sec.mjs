// Workflow: "Fix a security finding" — PatchEval-Verified (bytedance/PatchEval, ghcr.io/patcheval-cve).
// The agent gets PatchEval's own Claude Code prompt (CVE, CWE, vulnerable location) and no network.
// Pass = the agent's patch, minus any test-file changes, defeats the PoC exploit (fix-run.sh) and
// keeps the project's unit tests green (unit_test.sh), each in a fresh container.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as docker from '../lib/docker.mjs';
import { validity } from '../lib/validity.mjs';

const WORK = resolve(process.env.BENCH_WORK_ROOT || 'bench/.work');
const PROMPTS = JSON.parse(readFileSync(new URL('./sec.prompts.json', import.meta.url), 'utf8'));

// Files the image ships for grading. The agent must not see them: fix.patch is the reference fix,
// poc/ the exploit. They are masked with empty mounts, not deleted.
const HIDDEN = /^(.*\.patch|.*\.sh|\.patcheval_original_head)$/;
// Test code and test runners: a patch may not change how the fix is judged.
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|testdata)\/|(_test\.go|_spec\.rb|\.(test|spec)\.[cm]?[jt]sx?)$|(^|\/)(test_[^/]*\.py|conftest\.py|runtests\.py|package\.json|go\.mod|go\.sum|pytest\.ini|tox\.ini|jest\.config\.[cm]?[jt]s)$/;

function git(args, cwd) {
  const r = spawnSync('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@token-wise', '-c', 'safe.directory=*', ...args],
    { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr.slice(-400)}`);
  return r.stdout;
}

// Splits a patch per file; drops test-path files. Editing an existing test file counts as tampering.
export function screen(patch) {
  const blocks = patch.split(/^(?=diff --git )/m).filter((b) => b.startsWith('diff --git '));
  const kept = [];
  const dropped = [];
  for (const b of blocks) {
    const file = (b.match(/^diff --git a\/(\S+) b\//) || [])[1] || '';
    if (TEST_PATH.test(file)) dropped.push({ file, created: /^new file mode/m.test(b) });
    else kept.push(b);
  }
  return { patch: kept.join(''), dropped, tampered: dropped.some((d) => !d.created) };
}

function grade(image, script, patchFile, name) {
  docker.start(name, image, { network: 'none', workdir: '/workspace' });
  docker.copyIn(name, patchFile, '/workspace/fix.patch');
  // A task without unit tests has no unit_test.sh; that half of the check then passes vacuously.
  const r = docker.exec(name, `[ -f /workspace/${script} ] || { echo 0; echo no ${script}; exit 0; }; `
    + `timeout 1200 bash /workspace/${script} > /tmp/out.log 2>&1; echo $?; tail -c 500 /tmp/out.log`, { timeout: 1_300_000 });
  docker.remove(name);
  return { exit: Number(r.stdout.split('\n')[0]), tail: r.stdout.split('\n').slice(1).join('\n') };
}

export default {
  kind: 'fix a reported security vulnerability (CVE) in an open-source project',

  async tasks(set) {
    const valid = validity('sec');
    return JSON.parse(readFileSync(new URL(`./sec.${set}.json`, import.meta.url), 'utf8')).map((t) => ({ id: t.cve, ...t }))
      .filter((t) => valid[t.id]?.ok !== false);
  },

  // A task is kept only if the reference fix passes both halves of the check.
  async validate(task, ctx) {
    const tmp = `${ctx.container}-gold`;
    spawnSync('docker', ['create', '--name', tmp, task.image], { stdio: 'ignore' });
    docker.copyOut(tmp, '/workspace/fix.patch', join(ctx.taskDir, 'gold.patch'));
    docker.remove(tmp);
    const poc = grade(task.image, 'fix-run.sh', join(ctx.taskDir, 'gold.patch'), `${ctx.container}-poc`);
    const unit = grade(task.image, 'unit_test.sh', join(ctx.taskDir, 'gold.patch'), `${ctx.container}-unit`);
    const gold = screen(readFileSync(join(ctx.taskDir, 'gold.patch'), 'utf8'));
    return {
      ok: poc.exit === 0 && unit.exit === 0,
      why: `reference fix: poc exit ${poc.exit}, unit exit ${unit.exit}`,
      gold_touches_tests: gold.dropped.map((d) => d.file),
    };
  },

  // Seed 1 keeps the designed interleaving of clusters; later seeds rotate it.
  order(list, seed) {
    const sorted = [...list].sort((x, y) => x.pos - y.pos);
    const k = ((Number(seed) - 1) * 4) % sorted.length;
    return [...sorted.slice(k), ...sorted.slice(0, k)];
  },

  async prepare(task, ctx) {
    const repo = task.workdir;                                   // e.g. /workspace/django
    const workdir = join(WORK, `${ctx.container}-${Date.now()}`, repo.split('/').at(-1));
    mkdirSync(workdir, { recursive: true });
    const tmp = `${ctx.container}-src`;
    spawnSync('docker', ['create', '--name', tmp, task.image], { stdio: 'ignore' });
    docker.copyOut(tmp, `${repo}/.`, workdir);
    docker.remove(tmp);
    ctx.base = git(['rev-parse', 'HEAD'], workdir).trim();
    ctx.workdir = workdir;

    const list = spawnSync('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'ls', task.image, '-A', '/workspace'], { encoding: 'utf8' });
    const entries = list.stdout.split('\n');
    const mounts = [[workdir, workdir], ...entries.filter((f) => HIDDEN.test(f)).map((f) => ['/dev/null', `/workspace/${f}:ro`])];
    docker.start(ctx.container, task.image, { mounts, tmpfs: entries.includes('poc') ? ['/workspace/poc'] : [], workdir, network: 'none' });
    docker.exec(ctx.container, `mv ${repo} ${repo}.orig && ln -s ${workdir} ${repo}`, { shell: 'sh' });

    const prompt = `${PROMPTS[task.cve].replaceAll(repo, workdir).trim()}\n\nThe code repository is at ${workdir}.\n\n`
      + `Note: your Bash tool runs on the project's machine (no network). Your file tools (Read, Edit, Write) can only reach ${workdir}; use Bash for anything else.`;
    const brief = `Security fix (${task.lang}) in ${task.repo}: ${task.cwe.join(', ')}. ${PROMPTS[task.cve].split('## Vulnerability Description')[1]?.split('##')[0].trim().slice(0, 400) || ''}`;
    return { workdir, prompt, brief };
  },

  async verify(task, ctx) {
    docker.exec(ctx.container, `chown -R ${process.getuid()}:${process.getgid()} ${ctx.workdir}`, { shell: 'sh', timeout: 600_000 });
    git(['add', '-A'], ctx.workdir);
    const raw = git(['diff', '--cached', '--binary', ctx.base], ctx.workdir);
    writeFileSync(join(ctx.taskDir, 'agent.raw.patch'), raw);
    const s = screen(raw);
    const patchFile = join(ctx.taskDir, 'agent.patch');
    writeFileSync(patchFile, s.patch);
    if (!s.patch.trim()) return { pass: false, tampered: s.tampered, detail: { empty: true, dropped: s.dropped } };

    const poc = grade(task.image, 'fix-run.sh', patchFile, `${ctx.container}-poc`);
    const unit = grade(task.image, 'unit_test.sh', patchFile, `${ctx.container}-unit`);
    return {
      pass: poc.exit === 0 && unit.exit === 0 && !s.tampered,
      tampered: s.tampered,
      detail: { poc_exit: poc.exit, unit_exit: unit.exit, dropped: s.dropped, poc_tail: poc.tail.slice(-250), unit_tail: unit.tail.slice(-250) },
    };
  },

  async cleanup(task, ctx) {
    docker.exec(ctx.container, `chown -R ${process.getuid()}:${process.getgid()} ${ctx.workdir}`, { shell: 'sh', timeout: 600_000 });
    docker.remove(ctx.container);
  },
};
