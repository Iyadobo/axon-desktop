// Parses one Claude Code stream-json line into a normalized event, or null if ignorable.
// Pure (no Electron, no I/O) so it can be self-checked.
//
// Returns { flow } where flow is an ORDERED list of actions, preserving the real
// sequence of reasoning, tool calls, tool results and text. The renderer walks it
// top-to-bottom so the transcript reads in arrival order instead of being split
// into separate "steps above / text below" buckets.
//   { act: 'delta', text }                 assistant prose
//   { act: 'step', step: { type: 'thinking', text } }   reasoning block
//   { act: 'step', step: { type: 'tool_call', fn, args } }
//   { act: 'step', step: { type: 'tool_result', result } }
//   { act: 'done', is_error, result, session_id }
function parseEvent(line) {
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  switch (o.type) {
    case 'assistant': {
      const flow = [];
      for (const b of o.message?.content || []) {
        if (b.type === 'text' && b.text) flow.push({ act: 'delta', text: b.text });
        else if (b.type === 'thinking') { const t = String(b.thinking || b.text || ''); if (t) flow.push({ act: 'step', step: { type: 'thinking', text: t } }); }
        else if (b.type === 'tool_use') flow.push({ act: 'step', step: { type: 'tool_call', fn: b.name, args: b.input ?? {} } });
      }
      return flow.length ? { flow } : null;
    }
    case 'user': {
      const flow = [];
      for (const b of o.message?.content || []) {
        if (b.type === 'tool_result') flow.push({ act: 'step', step: { type: 'tool_result', result: typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '') } });
      }
      return flow.length ? { flow } : null;
    }
    case 'result':
      return { flow: [{ act: 'done', is_error: !!o.is_error, result: o.result ?? '', session_id: o.session_id }] };
    case 'error':
      return { flow: [{ act: 'done', is_error: true, result: o.message || o.error || 'error' }] };
    default:
      return null; // 'system' init, etc.
  }
}

module.exports = { parseEvent };