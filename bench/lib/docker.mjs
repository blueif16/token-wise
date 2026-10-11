// Thin wrappers over the docker CLI for task containers.
import { spawnSync } from 'node:child_process';

function docker(args, { timeout = 600_000, input } = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout, input, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? (r.signal ? 124 : 1), stdout: r.stdout || '', stderr: r.stderr || '' };
}

export function start(name, image, { mounts = [], tmpfs = [], workdir, env = {}, platform, network, init = true } = {}) {
  docker(['rm', '-f', name]);
  const args = ['run', '-d', '--name', name, '--label', 'token-wise-bench=1'];
  if (init) args.push('--init');               // reaps background processes the agent leaves behind
  if (network) args.push('--network', network);
  if (platform) args.push('--platform', platform);
  for (const [host, ctr] of mounts) args.push('-v', `${host}:${ctr}`);
  for (const dir of tmpfs) args.push('--tmpfs', dir);   // an empty dir laid over what the image has there
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  if (workdir) args.push('-w', workdir);
  args.push('--entrypoint', 'sleep', image, 'infinity');
  const r = docker(args);
  if (r.code !== 0) throw new Error(`docker run ${image}: ${r.stderr.slice(-500)}`);
  return name;
}

export function exec(name, script, { timeout = 1_800_000, workdir, shell = 'bash' } = {}) {
  const run = shell === 'bash' ? ['bash', '-lc', script] : [shell, '-c', script];
  return docker(['exec', ...(workdir ? ['-w', workdir] : []), name, ...run], { timeout });
}

export function copyIn(name, from, to) {
  const r = docker(['cp', from, `${name}:${to}`]);
  if (r.code !== 0) throw new Error(`docker cp ${from}: ${r.stderr.slice(-500)}`);
}

export function copyOut(name, from, to) {
  const r = docker(['cp', `${name}:${from}`, to]);
  if (r.code !== 0) throw new Error(`docker cp ${from}: ${r.stderr.slice(-500)}`);
}

export function remove(name) {
  docker(['rm', '-f', name]);
}

export function pull(image) {
  return docker(['pull', '-q', image], { timeout: 1_800_000 });
}
