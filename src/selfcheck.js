// Axon self-check: pure browser/config contracts plus local runtime probes.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { browserInvocation } = require('./browser-events');
const { createConfigStore } = require('./config');

let passed = 0, failed = 0;
const ok = (name, condition) => {
  if (condition) { passed++; console.log('  ✓', name); }
  else { failed++; console.error('  ✗ FAIL:', name); }
};

ok('browser open normalizes a URL', browserInvocation('browser_open', { url: 'https://example.com/docs' })?.url === 'https://example.com/docs');
ok('browser navigation aliases normalize', browserInvocation('browser_navigate', { href: 'https://example.com/next' })?.url === 'https://example.com/next');
ok('browser search opens a query', browserInvocation('web_search', { query: 'Axon agent browser' })?.url === 'https://www.google.com/search?q=Axon%20agent%20browser');
ok('non-browser tools leave the browser alone', browserInvocation('Read', { file_path: 'notes.md' }) === null);

(function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-config-'));
  try {
    const store = createConfigStore(dir);
    const workspace = path.join(dir, 'workspace');
    store.save({ osettings: { productMode: 'agent', systemPrompt: 'Be concise.' }, omodel: 'qwen3:4b', oRuntime: 'ollama', oactiveView: 'chat', odraft: 'unfinished note', oworkspace: workspace, blocked: 'nope' });
    const loaded = store.load();
    ok('config persists Axon mode and prompt', loaded.osettings.productMode === 'agent' && loaded.osettings.systemPrompt === 'Be concise.');
    ok('config persists active view', loaded.oactiveView === 'chat');
    ok('config persists workspace and draft', loaded.oworkspace === workspace && loaded.odraft === 'unfinished note');
    ok('config rejects unapproved state keys', !Object.hasOwn(loaded, 'blocked'));
    fs.unlinkSync(path.join(dir, 'settings.json'));
    ok('config restores from backup', store.load().omodel === 'qwen3:4b');
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
})();

(async () => {
  await new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:11434/api/tags', (res) => { res.resume(); console.log(`  ℹ ollama /api/tags -> ${res.statusCode}`); resolve(); });
    req.on('error', () => { console.log('  ℹ ollama not reachable (start it to use Axon Chat)'); resolve(); });
    req.setTimeout(2000, () => { req.destroy(); resolve(); });
  });

  console.log('llama.cpp runtime:');
  const runtimeOk = await require('./llamacpp-runtime').selfcheck();
  if (!runtimeOk) failed++;
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
