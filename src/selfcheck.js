// Axon self-check: pure browser/config contracts plus local runtime probes.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { browserInvocation } = require('./browser-events');
const { createConfigStore } = require('./config');
const { modelCapabilityReport, capabilityInstruction } = require('./capabilities');
const { updateRepository, updatePackageLabel, installerExtensions, releaseInstallerNames } = require('./update-policy');
const { requestWithRetry, cloudIdleTimeoutMs } = require('./ollama-cloud-agent');
const { resolveRoute, scopeInfo, scopeFromLegacy, engineSupportsProvider, engineRefusal, migrateProvider, normalizeEngine } = require('./engines');
const { openCodePermission, openCodeLaunchConfig } = require('./opencode-adapter');

let passed = 0, failed = 0;
const ok = (name, condition) => {
  if (condition) { passed++; console.log('  ✓', name); }
  else { failed++; console.error('  ✗ FAIL:', name); }
};

ok('browser open normalizes a URL', browserInvocation('browser_open', { url: 'https://example.com/docs' })?.url === 'https://example.com/docs');
ok('browser navigation aliases normalize', browserInvocation('browser_navigate', { href: 'https://example.com/next' })?.url === 'https://example.com/next');
ok('browser search opens a query', browserInvocation('web_search', { query: 'Axon agent browser' })?.url === 'https://www.google.com/search?q=Axon%20agent%20browser');
ok('non-browser tools leave the browser alone', browserInvocation('Read', { file_path: 'notes.md' }) === null);
ok('Windows updates offer the NoCLI.ai migration installer', updateRepository('win32', {}) === 'Iyadobo/nocli.ai-releases' && releaseInstallerNames('win32', '1.2.3').join() === 'nocli.ai-Setup-1.2.3.exe');
ok('Linux updates use only the Debian package feed', updateRepository('linux', {}) === 'Iyadobo/Axon-Debian' && updatePackageLabel('linux') === 'Debian package' && installerExtensions('linux').join() === 'deb' && releaseInstallerNames('linux', '1.2.3').join() === 'Axon_1.2.3_amd64.deb');
{
  const textOnly = modelCapabilityReport({ model: 'qwen3:4b', productMode: 'agent', advertisedVision: false });
  const vision = modelCapabilityReport({ model: 'llava', productMode: 'code', advertisedVision: true });
  ok('text-only models cannot receive screenshots', !textOnly.vision && !textOnly.browserScreenshot);
  ok('vision models can inspect agent browser screenshots', vision.vision && vision.browserScreenshot);
  ok('capability prompt prevents borrowed product identity', /not Claude, ChatGPT, Codex/.test(capabilityInstruction(textOnly)) && /screenshots are unavailable/.test(capabilityInstruction(textOnly)));
}
{
  // Scope is the single control that replaced Chat/Code/Work plus the separate
  // permission selector; it must still resolve to the same capability contract.
  ok('scope maps onto the capability contract', scopeInfo('chat').productMode === 'chat' && !scopeInfo('chat').usesEngine
    && scopeInfo('read').productMode === 'code' && scopeInfo('read').permission === 'approve'
    && scopeInfo('edit').permission === 'auto' && scopeInfo('full').productMode === 'agent');
  ok('legacy modes recover their nearest scope', scopeFromLegacy('agent', 'auto') === 'full'
    && scopeFromLegacy('code', 'approve') === 'read' && scopeFromLegacy('code', 'auto') === 'edit'
    && scopeFromLegacy('chat', 'auto') === 'chat');
  ok('unknown scope falls back to chat', scopeInfo('nonsense').id === 'chat');
  // An engine on a route it cannot speak is refused before spawn, with a reason.
  ok('engines declare the routes they can drive', engineSupportsProvider('qwen', 'openai-compatible')
    && engineSupportsProvider('kimi', 'ollama') && engineSupportsProvider('kimi', 'openai-compatible')
    && engineSupportsProvider('opencode', 'opencode') && engineSupportsProvider('opencode', 'openai-compatible')
    && !engineSupportsProvider('claude', 'openai-compatible') && engineSupportsProvider('codex', 'responses')
    && !engineSupportsProvider('codex', 'openai-compatible'));
  ok('an unsupported engine pair is refused with a reason', /Responses-compatible/.test(engineRefusal('codex', 'openai-compatible') || '')
    && engineRefusal('qwen', 'ollama') === null);
  ok('chat scope never spawns an engine', resolveRoute({ scope: 'chat', engine: 'codex', providerKind: 'openai-compatible' }).runner === 'direct');
  ok('OpenCode auth chats use the credential-owning CLI', resolveRoute({ scope: 'chat', engine: 'kimi', providerKind: 'opencode' }).runner === 'opencode');
  ok('workspace scope routes to the selected engine', resolveRoute({ scope: 'edit', engine: 'qwen', providerKind: 'ollama' }).runner === 'qwen'
    && resolveRoute({ scope: 'edit', engine: 'kimi', providerKind: 'ollama' }).runner === 'kimi'
    && resolveRoute({ scope: 'edit', engine: 'opencode', providerKind: 'openai-compatible' }).runner === 'opencode'
    && resolveRoute({ scope: 'full', engine: 'none', providerKind: 'ollama' }).runner === 'native'
    && resolveRoute({ scope: 'edit', engine: 'claude', providerKind: 'openai-compatible' }).runner === 'refused');
  // The old single field mixed route and harness; saved profiles must survive.
  ok('legacy provider kinds split into route and engine', migrateProvider({ kind: 'codex-cli' }).engine === 'codex'
    && migrateProvider({ kind: 'codex-cli' }).kind === 'ollama'
    && migrateProvider({ kind: 'claude-cli' }).engine === 'claude'
    && migrateProvider({ kind: 'openai-compatible' }).kind === 'openai-compatible'
    && normalizeEngine('bogus') === 'kimi' && migrateProvider({ kind: 'ollama' }).engine === 'kimi');
}

{
  const go = openCodeLaunchConfig({ provider: { kind: 'opencode' }, model: 'opencode-go/kimi-k3', scope: 'chat' });
  const router = openCodeLaunchConfig({ provider: { kind: 'openai-compatible', name: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1' }, model: 'moonshotai/kimi-k2.5', scope: 'edit', apiKey: 'test-only' });
  ok('OpenCode Go and Zen keep credentials in OpenCode', go.launchModel === 'opencode-go/kimi-k3' && !go.config.provider && go.config.agent.axon.permission['*'] === 'deny');
  ok('OpenRouter is injected process-locally for OpenCode', router.launchModel === 'axon-api/moonshotai/kimi-k2.5'
    && router.config.provider['axon-api'].options.baseURL === 'https://openrouter.ai/api/v1'
    && router.config.provider['axon-api'].options.apiKey === '{env:AXON_OPENCODE_API_KEY}'
    && router.env.AXON_OPENCODE_API_KEY === 'test-only');
  ok('OpenCode scope permissions are enforced by configuration', openCodePermission('read').edit === undefined
    && openCodePermission('read')['*'] === 'deny' && openCodePermission('edit').task === 'deny'
    && openCodePermission('full')['*'] === 'allow');
}

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
  await new Promise((resolve, reject) => {
    let requests = 0;
    const server = http.createServer((req, res) => {
      req.resume(); req.on('end', () => {
        requests++;
        if (requests === 1) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'busy' })); return; }
        if (requests === 3) return;
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(`${JSON.stringify({ message: { content: 'hello ' }, done: false })}\n`);
        setTimeout(() => res.end(`${JSON.stringify({ message: { content: 'world' }, done: true })}\n`), 20);
      });
    });
    server.listen(0, '127.0.0.1', async () => {
      try {
        const streamed = [];
        const result = await requestWithRetry(`http://127.0.0.1:${server.address().port}`, { model: 'selfcheck', stream: true }, {}, { idleTimeoutMs: 1000, retryDelayMs: 1, onContent: (part) => streamed.push(part) });
        ok('cloud chat streams long work and retries one gateway failure', requests === 2 && result.message.content === 'hello world' && streamed.join('') === 'hello world');
        ok('cloud idle timeout is configurable and safely bounded', cloudIdleTimeoutMs('1000') === 30000 && cloudIdleTimeoutMs('99999999') === 1800000);
        let timeoutError = null;
        try { await requestWithRetry(`http://127.0.0.1:${server.address().port}`, { model: 'timeout-selfcheck', stream: true }, {}, { idleTimeoutMs: 25, retryDelayMs: 1 }); }
        catch (error) { timeoutError = error; }
        ok('cloud timeout never duplicates an in-flight generation', requests === 3 && /was quiet/.test(timeoutError?.message || ''));
      } catch (error) { console.error(error); failed++; }
      finally { server.close(resolve); }
    });
    server.on('error', reject);
  });

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
