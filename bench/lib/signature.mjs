// A failure signature names the problem, not the instance: two agents that hit the same
// missing compiler in different repos get the same signature.

const KEY_LINE = /(error|exception|fatal|failed|failure|not found|no such|denied|cannot|could not|unable|missing|refused|invalid|traceback|ERR!)/i;

function informativeLine(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((l) => !/^exit code \d+$/i.test(l));
  // The last matching line is usually the root cause (Python tracebacks, Maven, npm).
  const hits = lines.filter((l) => KEY_LINE.test(l));
  return hits.at(-1) || lines.at(-1) || '';
}

export function normalize(line) {
  return line
    .toLowerCase()
    .replace(/\x1b\[[0-9;]*m/g, '')                  // ANSI colour
    .replace(/(?:\/[\w.@+-]+){2,}\/?/g, '<path>')   // absolute and nested paths
    .replace(/\b[0-9a-f]{7,}\b/g, '<hex>')
    .replace(/\d+(\.\d+)*/g, '<n>')                 // numbers and versions
    .replace(/(['"`]).*?\1/g, '<q>')                // quoted names
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

export function signature(error) {
  return normalize(informativeLine(error));
}

// The command's program name, so `pip install x` and `pip install y` failing the same way match.
export function program(command = '') {
  const first = String(command).replace(/^(?:\s*(?:sudo|env \S+=\S+|[A-Z_]+=\S+)\s+)+/, '').trim().split(/\s+/)[0] || '';
  return first.split('/').at(-1);
}
