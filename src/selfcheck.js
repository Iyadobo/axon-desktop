// Self-check: exercises the Claude Code stream-json parser (pure) + pings Ollama.
// Run: npm run check   (no Electron, no LLM call needed)
const assert = require('assert');
const http = require('http');
const { parseEvent } = require('./cc');

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.error('  ✗ FAIL:', n); } };

// 1. assistant text blocks -> ordered delta actions
(function () {
  const ev = parseEvent(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }] } }));
  ok('assistant text -> deltas', ev && ev.flow.length === 2 && ev.flow[0].act === 'delta' && ev.flow[0].text === 'Hello ' && ev.flow[1].text === 'world');
})();

// 2. assistant tool_use -> step tool_call
(function () {
  const ev = parseEvent(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.txt' } }] } }));
  ok('tool_use -> tool_call step', ev && ev.flow[0]?.act === 'step' && ev.flow[0].step.type === 'tool_call' && ev.flow[0].step.fn === 'Read' && ev.flow[0].step.args.file_path === 'a.txt');
})();

// 3. user tool_result -> step
(function () {
  const ev = parseEvent(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }] } }));
  ok('tool_result -> step', ev && ev.flow[0]?.act === 'step' && ev.flow[0].step.type === 'tool_result' && ev.flow[0].step.result === 'file body');
  // tool_result content as array -> stringified
  const ev2 = parseEvent(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'x' }] }] } }));
  ok('tool_result array -> stringified', ev2 && typeof ev2.flow[0].step.result === 'string');
})();

// 4. result event -> done action
(function () {
  const ev = parseEvent(JSON.stringify({ type: 'result', is_error: false, result: 'final answer', session_id: 'abc' }));
  ok('result -> done', ev && ev.flow[0]?.act === 'done' && ev.flow[0].is_error === false && ev.flow[0].result === 'final answer' && ev.flow[0].session_id === 'abc');
  const err = parseEvent(JSON.stringify({ type: 'result', is_error: true, result: 'boom' }));
  ok('result error flagged', err && err.flow[0].is_error === true);
})();

// 5. thinking block -> thinking step (no longer dropped)
(function () {
  const ev = parseEvent(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'let me reason' }] } }));
  ok('assistant thinking -> thinking step', ev && ev.flow[0]?.act === 'step' && ev.flow[0].step.type === 'thinking' && ev.flow[0].step.text === 'let me reason');
})();

// 6. ordering preserved: thinking -> text -> tool_use in one assistant message
(function () {
  const ev = parseEvent(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'plan' }, { type: 'text', text: 'doing it' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }));
  ok('flow preserves block order', ev && ev.flow.length === 3 && ev.flow[0].step.type === 'thinking' && ev.flow[1].act === 'delta' && ev.flow[1].text === 'doing it' && ev.flow[2].step.fn === 'Bash');
})();

// 7. unknown / system / garbage -> null
ok('system event -> null', parseEvent(JSON.stringify({ type: 'system', subtype: 'init' })) === null);
ok('non-JSON -> null', parseEvent('not json at all') === null);
ok('assistant truly empty -> null', parseEvent(JSON.stringify({ type: 'assistant', message: { content: [] } })) === null);

// 8. opencode `run --format json` mapping (pure, src/oc.js).
// The fixtures below are verbatim lines captured from opencode 1.18.15.
(function () {
  const { parseOpencodeEvent, newOpencodeState } = require('./oc');
  const state = newOpencodeState();

  ok('opencode step_start -> no flow', (() => {
    const ev = parseOpencodeEvent('{"type":"step_start","sessionID":"ses_1","part":{"type":"step-start"}}', state);
    return ev && ev.flow.length === 0 && ev.sessionId === 'ses_1';
  })());

  // One settled tool event becomes a call AND its result, sharing a callID.
  const toolLine = '{"type":"tool_use","sessionID":"ses_1","part":{"type":"tool","tool":"read","callID":"call_9","state":{"status":"completed","input":{"filePath":"sample.js"},"output":"export const answer = 42;"}}}';
  const toolEv = parseOpencodeEvent(toolLine, state);
  ok('opencode tool_use -> call + result pair', toolEv && toolEv.flow.length === 2
    && toolEv.flow[0].step.type === 'tool_call' && toolEv.flow[0].step.fn === 'read'
    && toolEv.flow[0].step.args.filePath === 'sample.js'
    && toolEv.flow[1].step.type === 'tool_result' && toolEv.flow[1].step.result === 'export const answer = 42;'
    && toolEv.flow[0].step.id === toolEv.flow[1].step.id);
  ok('opencode repeated tool_use is deduped', (() => {
    const again = parseOpencodeEvent(toolLine, state);
    return again && again.flow.length === 0;
  })());

  ok('opencode text -> delta', (() => {
    const ev = parseOpencodeEvent('{"type":"text","sessionID":"ses_1","part":{"id":"prt_1","type":"text","text":"42"}}', state);
    return ev && ev.flow[0].act === 'delta' && ev.flow[0].text === '42';
  })());
  // A re-emitted part must yield only the new tail, never the whole text again.
  ok('opencode cumulative text -> only the tail', (() => {
    const ev = parseOpencodeEvent('{"type":"text","sessionID":"ses_1","part":{"id":"prt_1","type":"text","text":"42 is the answer"}}', state);
    return ev && ev.flow[0].text === ' is the answer';
  })());
  ok('opencode identical text repeat -> nothing', (() => {
    const ev = parseOpencodeEvent('{"type":"text","sessionID":"ses_1","part":{"id":"prt_1","type":"text","text":"42 is the answer"}}', state);
    return ev && ev.flow.length === 0;
  })());

  ok('opencode failed tool -> is_error result', (() => {
    const ev = parseOpencodeEvent('{"type":"tool_use","sessionID":"ses_1","part":{"tool":"bash","callID":"call_e","state":{"status":"error","input":{},"error":"exit 1"}}}', newOpencodeState());
    return ev && ev.flow[1].step.is_error === true && ev.flow[1].step.result === 'exit 1';
  })());
  ok('opencode reasoning -> thinking step', (() => {
    const ev = parseOpencodeEvent('{"type":"reasoning","sessionID":"ses_1","part":{"text":"weighing options"}}', newOpencodeState());
    return ev && ev.flow[0].step.type === 'thinking' && ev.flow[0].step.text === 'weighing options';
  })());
  ok('opencode error event -> error action', (() => {
    const ev = parseOpencodeEvent('{"type":"error","error":{"message":"model unavailable"}}', newOpencodeState());
    return ev && ev.flow[0].act === 'error' && ev.flow[0].message === 'model unavailable';
  })());
  ok('opencode non-JSON -> null', parseOpencodeEvent('opencode banner text', newOpencodeState()) === null);
})();

// 6. custom slash-command expansion (pure, src/commands.js)
(function () {
  const { expandCommand, stripFrontmatter, frontmatterDescription, maybeExpandSlash, listCommands } = require('./commands');
  const fs = require('fs'), os = require('os'), path = require('path');
  ok('expand $ARGUMENTS', expandCommand('Summarize $ARGUMENTS', 'foo bar') === 'Summarize foo bar');
  ok('expand $1 $2 + strip frontmatter', expandCommand('---\ndescription: x\n---\nDo $1 then $2', 'a b') === 'Do a then b');
  ok('expand empty args trims', expandCommand('Hi $ARGUMENTS', '') === 'Hi');
  ok('$1 does not clobber $10', expandCommand('$1 and $10', 'a') === 'a and $10');
  ok('stripFrontmatter', stripFrontmatter('---\na: 1\n---\nbody') === 'body');
  ok('frontmatterDescription', frontmatterDescription('---\ndescription: "Hi there"\n---\nbody') === 'Hi there');

  // discovery against a temp dir (no dependence on the user's ~/.claude/commands)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocmd-'));
  fs.writeFileSync(path.join(tmp, 'greet.md'), '---\ndescription: Say hi\n---\nGreet $ARGUMENTS warmly.');
  ok('maybeExpandSlash expands custom cmd', maybeExpandSlash('/greet Sam', [tmp]) === 'Greet Sam warmly.');
  ok('maybeExpandSlash passes unknown through', maybeExpandSlash('/nosuchcmd x', [tmp]) === '/nosuchcmd x');
  ok('maybeExpandSlash leaves plain text', maybeExpandSlash('hello world', [tmp]) === 'hello world');
  const cmds = listCommands([tmp]);
  ok('listCommands finds greet', cmds.length === 1 && cmds[0].name === 'greet' && cmds[0].description === 'Say hi');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
})();

// 7. ollama reachable (informational; does not fail the run)
(function () {
  const { createConfigStore } = require('./config');
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-config-'));
  try {
    const store = createConfigStore(dir);
    const workspace = path.join(dir, 'workspace');
    store.save({ osettings: { systemPrompt: 'Be concise.' }, omodel: 'qwen3:4b', odraft: 'unfinished note', oworkspace: workspace, olanHostEnabled: true, osharedConvs: [{ id: 'shared-1', turns: [] }], ocloudModels: { models: [{ name: 'example-cloud' }], fetchedAt: '2026-08-15T00:00:00.000Z' }, blocked: 'nope' });
    const loaded = store.load();
    ok('config persists approved app state', loaded.osettings.systemPrompt === 'Be concise.' && loaded.omodel === 'qwen3:4b');
    ok('config persists a bounded composer draft', loaded.odraft === 'unfinished note');
    ok('config persists the default workspace', loaded.oworkspace === workspace);
    ok('config persists LAN Host intent', loaded.olanHostEnabled === true);
    ok('config persists shared chat snapshots', loaded.osharedConvs?.[0]?.id === 'shared-1');
    ok('config persists the cloud model catalogue cache', loaded.ocloudModels?.models?.[0]?.name === 'example-cloud');
    ok('config rejects unapproved state keys', !Object.hasOwn(loaded, 'blocked'));
    fs.unlinkSync(path.join(dir, 'settings.json'));
    ok('config restores from its backup', store.load().odraft === 'unfinished note');
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
})();

(async () => {
  await new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:11434/api/tags', (res) => { res.resume(); console.log(`  ℹ ollama /api/tags -> ${res.statusCode}`); resolve(); });
    req.on('error', () => { console.log('  ℹ ollama not reachable (start it to use the app)'); resolve(); });
    req.setTimeout(2000, () => { req.destroy(); resolve(); });
  });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
