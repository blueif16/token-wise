// Per-workload task validity, written by bench/validate.mjs. Tasks marked invalid are left out of
// every arm; tasks never validated are kept.
import { existsSync, readFileSync } from 'node:fs';

export function validity(workload) {
  const f = new URL(`../workloads/${workload}.valid.json`, import.meta.url);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
}
