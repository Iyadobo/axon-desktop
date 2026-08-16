// Parses one line of `opencode run --format json` into normalized Axon events.
// Pure (no Electron, no I/O) so it can be self-checked, same contract as cc.js.
//
// opencode differs from Claude Code in two ways that matter here:
//   - it emits whole parts, not token deltas, so a "text" event carries the
//     finished text of that part rather than an increment;
//   - a tool event arrives already settled, carrying input AND output together,
//     so one event becomes a tool_call plus a tool_result.
//
// State is threaded across lines to dedupe: a part may legitimately be re-emitted
// (a future opencode could stream one cumulatively), and replaying the same text
// would duplicate it in the transcript.
//
// Returns { flow, sessionId } or null when the line carries nothing useful.
//   { act: 'delta', text }
//   { act: 'step', step: { type: 'thinking', text } }
//   { act: 'step', step: { type: 'tool_call', id, fn, args } }
//   { act: 'step', step: { type: 'tool_result', id, is_error, result } }
//   { act: 'error', message }
function newOpencodeState() {
  return { textSent: new Map(), callSent: new Set(), resultSent: new Set() };
}
function parseOpencodeEvent(line, state) {
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const s = state || newOpencodeState();
  const part = o.part && typeof o.part === 'object' ? o.part : {};
  const flow = [];
  switch (o.type) {
    case 'text': {
      if (typeof part.text !== 'string' || !part.text) break;
      const already = s.textSent.get(part.id) || 0;
      if (part.text.length > already) {
        flow.push({ act: 'delta', text: part.text.slice(already) });
        s.textSent.set(part.id, part.text.length);
      }
      break;
    }
    case 'reasoning': {
      const text = part.text || part.reasoning;
      if (text) flow.push({ act: 'step', step: { type: 'thinking', text: String(text) } });
      break;
    }
    case 'tool_use': {
      const id = part.callID || part.id;
      const st = part.state && typeof part.state === 'object' ? part.state : {};
      if (!s.callSent.has(id)) {
        s.callSent.add(id);
        flow.push({ act: 'step', step: { type: 'tool_call', id, fn: part.tool || 'tool', args: st.input ?? {} } });
      }
      const settled = st.status === 'completed' || st.status === 'error' || st.output != null || st.error != null;
      if (settled && !s.resultSent.has(id)) {
        s.resultSent.add(id);
        flow.push({ act: 'step', step: {
          type: 'tool_result', id,
          is_error: st.status === 'error' || st.error != null,
          result: String(st.output ?? st.error ?? st.status ?? ''),
        } });
      }
      break;
    }
    case 'error':
      flow.push({ act: 'error', message: o.error?.message || o.message || 'opencode failed to complete this turn.' });
      break;
    default:
      break; // step_start / step_finish and anything new: nothing to render
  }
  if (!flow.length && !o.sessionID) return null;
  return { flow, sessionId: o.sessionID || null };
}

module.exports = { parseOpencodeEvent, newOpencodeState };
