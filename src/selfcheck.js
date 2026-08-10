// Self-check: exercises the Claude Code stream-json parser (pure) + pings Ollama.
// Run: npm run check   (no Electron, no LLM call needed)
const assert = require('assert');
const http = require('http');
const { parseEvent } = require('./cc');

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.error('  ✗ FAIL:', n); } };

// 1. assistant text block -> delta
(function () {
  const ev = parseEvent(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }] } }));
  ok('assistant text -> deltas', ev && ev.deltas.length === 2 && ev.deltas[0] === 'Hello ' && ev.deltas[1] === 'world');
})();

// 2. assistant tool_use -> step tool_call
(function () {
  const ev = parseEvent(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.txt' } }] } }));
  ok('tool_use -> tool_call step', ev && ev.steps[0]?.type === 'tool_call' && ev.steps[0].fn === 'Read' && ev.steps[0].args.file_path === 'a.txt');
})();

// 3. user tool_result -> step
(function () {
  const ev = parseEvent(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }] } }));
  ok('tool_result -> step', ev && ev.steps[0]?.type === 'tool_result' && ev.steps[0].result === 'file body');
  // tool_result content as array -> stringified
  const ev2 = parseEvent(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'x' }] }] } }));
  ok('tool_result array -> stringified', ev2 && typeof ev2.steps[0].result === 'string');
})();

// 4. result event -> done
(function () {
  const ev = parseEvent(JSON.stringify({ type: 'result', is_error: false, result: 'final answer', session_id: 'abc' }));
  ok('result -> done', ev && ev.done === true && ev.is_error === false && ev.result === 'final answer' && ev.session_id === 'abc');
  const err = parseEvent(JSON.stringify({ type: 'result', is_error: true, result: 'boom' }));
  ok('result error flagged', err && err.is_error === true);
})();

// 5. unknown / system / garbage -> null
ok('system event -> null', parseEvent(JSON.stringify({ type: 'system', subtype: 'init' })) === null);
ok('non-JSON -> null', parseEvent('not json at all') === null);
ok('assistant with no content -> null', parseEvent(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } })) === null);

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
    store.save({ osettings: { systemPrompt: 'Be concise.' }, omodel: 'qwen3:4b', blocked: 'nope' });
    const loaded = store.load();
    ok('config persists approved app state', loaded.osettings.systemPrompt === 'Be concise.' && loaded.omodel === 'qwen3:4b');
    ok('config rejects unapproved state keys', !Object.hasOwn(loaded, 'blocked'));
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
