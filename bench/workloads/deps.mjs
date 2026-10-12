// Workflow: "Upgrade a dependency that breaks the build" — BUMP (chains-project/bump).
// A one-line pom bump breaks `mvn clean test`; the agent must make it pass at the new version.
// Pass = the agent's diff, applied in a fresh container, builds and passes every pre-bump test,
// keeps the dependency at the new version, and uses none of the known shortcuts.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as docker from '../lib/docker.mjs';
import { validity } from '../lib/validity.mjs';

const WORK = resolve(process.env.BENCH_WORK_ROOT || 'bench/.work');
const BASELINES = resolve('bench/.cache/bump-baseline');
const NETWORK = 'tw-bench';
const MVN = 'mvn clean test -B';

// The images are Alpine with no bash; add the tools an agent expects, once per image.
function agentImage(task) {
  const tag = `tw-bump:${task.task_id.slice(0, 12)}`;
  if (spawnSync('docker', ['image', 'inspect', tag], { stdio: 'ignore' }).status !== 0) {
    const r = spawnSync('docker', ['build', '-q', '-t', tag, '-'], {
      input: `FROM ${task.image}\nRUN apk add --no-cache bash coreutils grep findutils sed diffutils\n`, encoding: 'utf8', timeout: 900_000,
    });
    if (r.status !== 0) throw new Error(`build ${tag}: ${r.stderr.slice(-400)}`);
  }
  return tag;
}

function git(args, cwd) {
  const r = spawnSync('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@token-wise', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr.slice(-400)}`);
  return r.stdout;
}

// Surefire reports -> { 'Class#method': 'pass' | 'fail' | 'skip' }.
function surefire(container, repo) {
  const r = docker.exec(container, `find ${repo} -path '*/surefire-reports/TEST-*.xml' -exec cat {} + 2>/dev/null`, { timeout: 120_000, shell: 'sh' });
  const cases = {};
  for (const m of r.stdout.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attr = (k) => (m[1].match(new RegExp(`\\b${k}="([^"]*)"`)) || [])[1] || '';
    const body = m[3] || '';
    cases[`${attr('classname')}#${attr('name')}`] = /<(failure|error)\b/.test(body) ? 'fail' : /<skipped\b/.test(body) ? 'skip' : 'pass';
  }
  return cases;
}

// Tests that exist before the bump (BUMP's "-pre" image), measured once per task.
function baseline(task) {
  const file = join(BASELINES, `${task.task_id}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const pre = task.image.replace(/-breaking$/, '-pre');
  docker.pull(pre);
  const name = `tw-base-${task.task_id.slice(0, 12)}`;
  docker.start(name, pre, { workdir: task.workdir, network: NETWORK });
  const r = docker.exec(name, `${MVN} > /tmp/build.log 2>&1; echo $?`, { timeout: 2_400_000, shell: 'sh' });
  const out = { exit: Number(r.stdout.trim()), cases: surefire(name, task.workdir) };
  docker.remove(name);
  mkdirSync(BASELINES, { recursive: true });
  writeFileSync(file, JSON.stringify(out));
  return out;
}

const SHORTCUTS = [
  [/skipTests|maven\.test\.skip|testFailureIgnore|skipITs/, 'skips or ignores tests'],
  [/<skip>\s*true\s*<\/skip>|enforcer\.skip|checkstyle\.skip|spotbugs\.skip|pmd\.skip|rat\.skip|<fail>\s*false\s*<\/fail>/, 'switches off a check'],
  [/@(Disabled|Ignore)\b/, 'disables tests'],
  [/<(source|target|release|maven\.compiler\.(source|target|release))>/, 'changes the Java level'],
];

// Shortcuts in the lines the patch adds or removes. Downgrades are caught by the resolved-version check.
function lint(patch, task) {
  const issues = [];
  let file = '';
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ ')) file = line.slice(6);
    if (/^(\+\+\+|---) /.test(line) || !/^[+-]/.test(line)) continue;
    const added = line.startsWith('+');
    if (added) for (const [re, why] of SHORTCUTS) if (re.test(line)) issues.push(`${file}: ${why}: ${line.slice(1, 120).trim()}`);
    if (!added && /<module>/.test(line)) issues.push(`${file}: removes a module`);
    if (/\.mvn\/maven\.config$/.test(file)) issues.push(`${file}: edits maven.config`);
  }
  return [...new Set(issues)];
}

// Maven Central hiccups fail a correct patch (measured 2026-10-11: the same patch failed with
// DependencyResolutionException, then passed by hand). Such builds are retried in a fresh container.
const DOWNLOAD_FAIL = 'DependencyResolutionException|PluginResolutionException|Could not transfer artifact|Could not resolve dependencies|Connection reset|timed out|Remote host terminated|Transfer failed';

function build(task, image, patchFile, name) {
  // Fresh container: nothing the agent left in its own container (caches, edits outside git) counts.
  docker.start(name, image, { workdir: task.workdir, network: NETWORK });
  docker.copyIn(name, patchFile, '/tmp/agent.patch');
  const patch = readFileSync(patchFile, 'utf8');
  const applied = patch.trim() ? docker.exec(name, 'git apply --whitespace=nowarn /tmp/agent.patch', { workdir: task.workdir, shell: 'sh' }) : { code: 0 };
  const r = docker.exec(name, `timeout 2400 ${MVN} > /tmp/build.log 2>&1; echo $?; grep -cE '${DOWNLOAD_FAIL}' /tmp/build.log; tail -c 600 /tmp/build.log`, { timeout: 2_500_000 });
  const [exit, downloadErrors] = r.stdout.split('\n').map(Number);
  return { applied: applied.code === 0, exit, downloadErrors, tail: r.stdout.split('\n').slice(2).join('\n') };
}

function grade(task, patchFile, prefix) {
  const image = agentImage(task);
  const name = `${prefix}-check`;
  let b;
  let attempts = 0;
  do {
    attempts += 1;
    if (b) docker.remove(name);
    b = build(task, image, patchFile, name);
  } while (b.applied && b.exit !== 0 && b.downloadErrors > 0 && attempts < 3);
  const cases = surefire(name, task.workdir);
  const [g, art] = task.dependency.split(':');
  const dep = docker.exec(name, `mvn -B -q dependency:list -DincludeGroupIds=${g} -DincludeArtifactIds=${art} -DoutputFile=/tmp/deps.txt -DappendOutput=true >/dev/null 2>&1; `
    + `mvn -B -q help:effective-pom -Doutput=/tmp/eff.xml >/dev/null 2>&1; cat /tmp/deps.txt /tmp/eff.xml 2>/dev/null`, { timeout: 900_000 });
  docker.remove(name);

  const shortcuts = lint(readFileSync(patchFile, 'utf8'), task);
  const base = baseline(task);
  const missing = Object.keys(base.cases).filter((c) => base.cases[c] !== 'skip' && !(c in cases));
  const failing = Object.keys(cases).filter((c) => cases[c] === 'fail');
  const skipped = Object.values(cases).filter((s) => s === 'skip').length;
  const baseSkipped = Object.values(base.cases).filter((s) => s === 'skip').length;
  const keepsVersion = dep.stdout.includes(`${g}:${art}:jar:${task.new_version}`)
    || new RegExp(`<artifactId>${art}</artifactId>\\s*<version>${task.new_version.replace(/\./g, '\\.')}</version>`).test(dep.stdout);
  // Tests missing from a failed build just did not run; from a green build they were removed.
  const testsIntact = missing.length === 0 && skipped <= baseSkipped;
  const tampered = shortcuts.length > 0 || (b.exit === 0 && !testsIntact);
  const pass = b.applied && b.exit === 0 && failing.length === 0 && keepsVersion && testsIntact && !tampered;
  return {
    pass, tampered,
    detail: {
      applied: b.applied, exit: b.exit, attempts, tests: Object.keys(cases).length, baseline_tests: Object.keys(base.cases).length,
      failing: failing.slice(0, 10), missing: missing.slice(0, 10), skipped, baseline_skipped: baseSkipped,
      keeps_version: keepsVersion, shortcuts, tail: b.tail.slice(-300),
    },
  };
}

export default {
  kind: 'upgrade a dependency whose new version breaks the Maven build',

  async tasks(set) {
    const valid = validity('deps');
    return JSON.parse(readFileSync(new URL(`./deps.${set}.json`, import.meta.url), 'utf8'))
      .map((t) => ({ id: t.task_id.slice(0, 12), ...t }))
      .filter((t) => valid[t.id]?.ok !== false);
  },

  // A task is kept only if the project's tests pass before the bump, so a green build is reachable.
  async validate(task) {
    const b = baseline(task);
    const n = Object.keys(b.cases).length;
    return { ok: b.exit === 0 && n > 0, why: `pre-bump build exit ${b.exit}, ${n} tests` };
  },

  // Seed 1 keeps the designed order (clusters interleaved, a cold first member each);
  // later seeds rotate it so each cluster's first member changes.
  order(list, seed) {
    const sorted = [...list].sort((x, y) => x.position - y.position);
    const k = ((Number(seed) - 1) * 5) % sorted.length;
    return [...sorted.slice(k), ...sorted.slice(0, k)];
  },

  async prepare(task, ctx) {
    const image = agentImage(task);
    baseline(task);
    const workdir = join(WORK, `${ctx.container}-${Date.now()}`, task.workdir.slice(1));
    mkdirSync(workdir, { recursive: true });
    const tmp = `${ctx.container}-src`;
    spawnSync('docker', ['create', '--name', tmp, image], { stdio: 'ignore' });
    docker.copyOut(tmp, `${task.workdir}/.`, workdir);
    docker.remove(tmp);
    git(['init', '-q'], workdir);
    git(['add', '-A'], workdir);
    git(['commit', '-q', '-m', 'baseline: dependency bumped, build failing'], workdir);
    ctx.base = git(['rev-parse', 'HEAD'], workdir).trim();
    ctx.workdir = workdir;
    ctx.image = image;

    docker.start(ctx.container, image, { mounts: [[workdir, workdir]], workdir, network: NETWORK });
    // The image's own copy would be a decoy; point its path at the shared one.
    docker.exec(ctx.container, `mv ${task.workdir} ${task.workdir}.orig && ln -s ${workdir} ${task.workdir}`, { shell: 'sh' });

    const prompt = [
      `This Maven project is at ${workdir}. Its dependency ${task.dependency} was bumped from ${task.previous_version}`,
      `to ${task.new_version}, and \`${MVN}\` now fails (the failing CI log is in the repo root as a .log file).`,
      '',
      `Make the build and all existing tests pass while keeping ${task.dependency} at ${task.new_version}.`,
      'You may change main code, test code and poms, including adding or aligning other dependencies.',
      'Do not downgrade it; do not delete, disable or skip tests; do not relax enforcer, checkstyle or',
      `other build rules; do not change the Java level. Verify with \`${MVN}\`.`,
      '',
      `Note: your Bash tool runs on the build machine (Alpine, Java 11, Maven 3.9). Your file tools (Read, Edit, Write) can only reach ${workdir}; use Bash for anything else.`,
    ].join('\n');
    const brief = `Maven dependency upgrade breaks the build: ${task.dependency} ${task.previous_version} -> ${task.new_version} (${task.failure_category.toLowerCase().replace('_', ' ')})`;
    return { workdir, prompt, brief };
  },

  async verify(task, ctx) {
    docker.exec(ctx.container, `chown -R ${process.getuid()}:${process.getgid()} ${ctx.workdir}`, { shell: 'sh', timeout: 600_000 });
    const exclude = [':(exclude,glob)**/target/**', ':(exclude)*.log'];
    git(['add', '-A', '--', '.', ...exclude], ctx.workdir);
    writeFileSync(join(ctx.taskDir, 'agent.patch'), git(['diff', '--cached', '--binary', ctx.base, '--', '.', ...exclude], ctx.workdir));
    return grade(task, join(ctx.taskDir, 'agent.patch'), ctx.container);
  },

  // Re-grades a finished task from its saved patch (bench/regrade.mjs).
  async regrade(task, taskDir) {
    return grade(task, join(taskDir, 'agent.patch'), `tw-regrade-${task.id}`);
  },

  async cleanup(task, ctx) {
    docker.exec(ctx.container, `chown -R ${process.getuid()}:${process.getgid()} ${ctx.workdir}`, { shell: 'sh', timeout: 600_000 });
    docker.remove(ctx.container);
  },
};
