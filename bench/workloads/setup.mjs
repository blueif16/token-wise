// Workflow: "Get a repo building and its tests passing" — SetupBench (microsoft/SetupBench @041a412).
// Each task starts from a bare image; the official success_command decides pass/fail.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import * as docker from '../lib/docker.mjs';

const ROOT = resolve('bench/vendor/SetupBench/setupbench');
const WORK = resolve(process.env.BENCH_WORK_ROOT || 'bench/.work');
const REPOS = resolve('bench/.cache/repos');
const SETS = JSON.parse(readFileSync(new URL('./setup.sets.json', import.meta.url), 'utf8'));
const NETWORK = 'tw-bench';

const IMAGES = {
  'ubuntu:22.04': 'ubuntu@sha256:5ec03bb3441e8b0bf3b4f9cd4629a1ae763010dc3035bb8da3ae6cf026486401',
  // The benchmark's node-16 image is private (unauthorized, measured); the public image stands in.
  'codeexecservice.azurecr.io/setupbench-node-16:latest': 'node:16',
  'ruby:2.7': 'ruby:2.7',
};

// Pull-through caches shared by every arm, warmed before runs (see bench/README.md).
const CACHE_ENV = {
  PIP_INDEX_URL: 'http://tw-pypi:5000/index/', PIP_TRUSTED_HOST: 'tw-pypi',
  NPM_CONFIG_REGISTRY: 'http://tw-npm:4873/', YARN_REGISTRY: 'http://tw-npm:4873/',
};

const shq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const TEST_FILE = /(^|\/)(tests?|testing|__tests__|spec)\/|(^|\/)(test_[^/]*|[^/]*(_test|\.test|\.spec)\.[^/]+)$/;

function scenarios() {
  const dir = join(ROOT, 'scenarios');
  return readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 900_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.slice(-400)}`);
}

function cachedRepo(task) {
  const dir = join(REPOS, task.instance_id);
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(REPOS, { recursive: true });
    git(['clone', '--quiet', task.repo_url, dir]);
    if (task.base_commit) git(['checkout', '--quiet', task.base_commit], dir);
  }
  return dir;
}

// Hashes of existing test files, so a "pass" bought by editing or deleting tests is caught.
function testManifest(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name === '.git' || name === 'node_modules') continue;
      const p = join(d, name);
      const st = statSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) walk(p);
      else if (TEST_FILE.test(relative(dir, p))) out[relative(dir, p)] = createHash('sha1').update(readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

export default {
  kind: 'set up a repository or service from a bare machine',

  async tasks(set) {
    const byId = Object.fromEntries(scenarios().map((t) => [t.instance_id, t]));
    return SETS[set].map((id) => ({ id, ...byId[id] }));
  },

  async prepare(task, ctx) {
    const workdir = join(WORK, `${ctx.container}-${Date.now()}`, 'testbed');
    mkdirSync(workdir, { recursive: true });
    if (task.repo_url) cpSync(cachedRepo(task), workdir, { recursive: true });
    const fixture = join(ROOT, 'fixtures', task.instance_id);
    if (existsSync(fixture)) cpSync(fixture, workdir, { recursive: true });
    writeFileSync(join(ctx.taskDir, 'tests.manifest.json'), JSON.stringify(testManifest(workdir)));

    docker.start(ctx.container, IMAGES[task.base_image] || task.base_image, {
      mounts: [[workdir, workdir]], workdir, network: NETWORK, env: CACHE_ENV,
    });
    // The task text says /testbed; the repo lives at the same path on host and container.
    docker.exec(ctx.container, `ln -sfn ${workdir} /testbed && echo 'Acquire::http::Proxy "http://tw-apt:3142";' > /etc/apt/apt.conf.d/01proxy`, { shell: 'sh' });
    const pre = join(ROOT, 'fixtures', `prerunner-${task.instance_id}`, 'prerunner.sh');
    if (existsSync(pre)) {
      docker.copyIn(ctx.container, pre, '/tmp/prerunner.sh');
      const r = docker.exec(ctx.container, 'bash /tmp/prerunner.sh', { timeout: 900_000, workdir: '/testbed', shell: 'sh' });
      writeFileSync(join(ctx.taskDir, 'prerunner.log'), `${r.code}\n${r.stdout}\n${r.stderr}`);
    }
    ctx.workdir = workdir;

    const prompt = `${task.problem_statement.replaceAll('/testbed', workdir)}\n\n`
      + `Note: your Bash tool runs on that machine. Your file tools (Read, Edit, Write) can only reach ${workdir}; use Bash for anything else.`;
    const brief = [task.task_type, task.language, task.ecosystem, task.repo_url || task.instance_id, (task.notes || '').slice(0, 600)]
      .filter(Boolean).join(' · ');
    return { workdir, prompt, brief };
  },

  async verify(task, ctx) {
    const r = docker.exec(ctx.container, `timeout 900 sh -c ${shq(task.success_command)}`, { timeout: 960_000, workdir: '/testbed', shell: 'sh' });
    const output = `${r.stdout}${r.stderr}`;
    const pass = task.task_type === 'dependency_resolution' ? r.code === 0 : output.includes('Setup successful');
    const before = JSON.parse(readFileSync(join(ctx.taskDir, 'tests.manifest.json'), 'utf8'));
    const after = testManifest(ctx.workdir);
    const touched = Object.keys(before).filter((f) => before[f] !== after[f]);
    return { pass, tampered: touched.length > 0, detail: { exit: r.code, tail: output.slice(-400), tests_touched: touched.slice(0, 20) } };
  },

  async cleanup(task, ctx) {
    // Files written by the container are root-owned; hand them back so the workspace can be removed later.
    docker.exec(ctx.container, `chown -R ${process.getuid()}:${process.getgid()} ${ctx.workdir}`, { shell: 'sh', timeout: 600_000 });
    docker.remove(ctx.container);
  },
};
