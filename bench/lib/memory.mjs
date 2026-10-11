// Lesson memory for one benchmark run, stored in Senso. The local index (lessons.json) is the
// source of truth for which lessons an arm may retrieve; Senso holds the text and does the search.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { redact } from '../../tracing/lib/redact.mjs';

const senso = (args, opts = {}) =>
  JSON.parse(execFileSync('senso', [...args, '--output', 'json', '--no-update-check'], {
    encoding: 'utf8', timeout: opts.timeout ?? 60_000, stdio: ['ignore', 'pipe', 'pipe'],
  }));

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export class LessonIndex {
  constructor(path) {
    this.path = path;
    this.lessons = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
  }

  save() {
    writeFileSync(this.path, JSON.stringify(this.lessons, null, 2));
  }

  // Gated arms only retrieve lessons that passed the gate and have not been retired.
  retrievable(arm) {
    return this.lessons.filter((l) => (arm === 'gated' ? l.status === 'verified' || l.status === 'proven' : true));
  }

  // Outcome bookkeeping for every lesson the agent was shown during a task. Only the gated arm
  // retires lessons; ungated memory keeps everything, as most agent memory does today.
  recordUse(ids, passed, arm) {
    for (const l of this.lessons.filter((x) => ids.includes(x.id))) {
      l.uses += 1;
      if (passed) l.passes += 1;
      if (l.status === 'verified' && passed) l.status = 'proven';
      // Shown three times and never followed by a pass: it is not helping, stop serving it.
      if (arm === 'gated' && l.uses >= 3 && l.passes === 0) l.status = 'retired';
    }
  }
}

export function lessonMarkdown(lesson) {
  return redact([
    `# ${lesson.id}`,
    `workload: ${lesson.workload} · source task: ${lesson.source_task} · status: ${lesson.status}`,
    '',
    '## When you see',
    lesson.when,
    '',
    '## Do this instead',
    lesson.action,
    '',
    '## Evidence',
    lesson.evidence,
  ].join('\n'));
}

export function createFolder(name, parentId) {
  return senso(['kb', 'create-folder', '--name', name, ...(parentId ? ['--parent-id', parentId] : [])]).kb_node_id;
}

// Writes the lesson and waits until Senso can search it (about 15 s, measured 2026-10-11).
export function storeLesson(lesson, folderId, { wait = 120_000 } = {}) {
  const created = senso(['kb', 'create-raw', '--data', JSON.stringify({
    title: `${lesson.id}.md`, text: lessonMarkdown(lesson), kb_folder_node_id: folderId,
  })]);
  const deadline = Date.now() + wait;
  for (;;) {
    const node = senso(['kb', 'get', created.kb_node_id]);
    const status = node.content?.processing_status ?? node.processing_status;
    if (status === 'complete') return { kb_node_id: created.kb_node_id, content_id: node.content?.id ?? created.id };
    if (status === 'failed' || Date.now() > deadline) throw new Error(`lesson ${lesson.id} not searchable: ${status}`);
    sleep(3000);
  }
}

// Hybrid search scoped to the lessons this arm may see; unrelated queries return nothing.
export function searchLessons(query, contentIds, { max = 3 } = {}) {
  if (!contentIds.length) return [];
  const res = senso(['search', 'context', query.slice(0, 600), '--content-ids', ...contentIds,
    '--require-scoped-ids', '--no-gap-signals', '--max-results', String(max)], { timeout: 30_000 });
  const seen = new Set();
  return (res.results || []).filter((r) => !seen.has(r.content_id) && seen.add(r.content_id))
    .map((r) => ({ content_id: r.content_id, score: r.score, text: r.chunk_text }));
}
