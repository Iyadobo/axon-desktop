// Parses one Claude Code stream-json line into a normalized event, or null if ignorable.
// Pure (no Electron, no I/O) so it can be self-checked.
function parseEvent(line) {
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  switch (o.type) {
    case 'assistant': {
      const ev = { deltas: [], steps: [] };
      for (const b of o.message?.content || []) {
        if (b.type === 'text' && b.text) ev.deltas.push(b.text);
        else if (b.type === 'tool_use') ev.steps.push({ type: 'tool_call', fn: b.name, args: b.input ?? {} });
      }
      return ev.deltas.length || ev.steps.length ? ev : null;
    }
    case 'user': {
      const steps = [];
      for (const b of o.message?.content || []) {
        if (b.type === 'tool_result') steps.push({ type: 'tool_result', result: typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '') });
      }
      return steps.length ? { deltas: [], steps } : null;
    }
    case 'result':
      return { deltas: [], steps: [], done: true, is_error: !!o.is_error, result: o.result ?? '', session_id: o.session_id };
    case 'error':
      return { deltas: [], steps: [], done: true, is_error: true, result: o.message || o.error || 'error' };
    default:
      return null; // 'system' init, etc.
  }
}

module.exports = { parseEvent };