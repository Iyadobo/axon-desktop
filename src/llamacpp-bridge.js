// Translates between the Anthropic Messages API (what Claude Code's CLI speaks
// to ANTHROPIC_BASE_URL) and llama-server's OpenAI-compatible /v1/chat/completions
// endpoint. Ollama implements the Anthropic protocol natively so no bridge was
// needed for it or for Exo; llama.cpp only speaks OpenAI-style chat completions,
// so Claude Code cannot point at it directly -- this is the real adapter that
// makes that possible. Pure translation functions are exported separately from
// the HTTP server so they can be self-checked without a running llama-server.
const http = require('http');

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
}

function anthropicToolsToOpenAI(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } } }));
}

function anthropicToolChoiceToOpenAI(choice) {
  if (!choice) return undefined;
  if (choice.type === 'auto') return 'auto';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'tool' && choice.name) return { type: 'function', function: { name: choice.name } };
  return undefined;
}

// A tool_result block must become its own OpenAI 'tool' message; it cannot
// share a message with plain user text the way Anthropic's format allows.
function anthropicMessagesToOpenAI(messages) {
  const out = [];
  for (const msg of Array.isArray(messages) ? messages : []) {
    const blocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content ?? '') }];
    if (msg.role === 'assistant') {
      const text = textOf(blocks);
      const toolUses = blocks.filter((b) => b?.type === 'tool_use');
      const entry = { role: 'assistant', content: text || null };
      if (toolUses.length) entry.tool_calls = toolUses.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) } }));
      out.push(entry);
      continue;
    }
    const toolResults = blocks.filter((b) => b?.type === 'tool_result');
    const rest = blocks.filter((b) => b?.type !== 'tool_result');
    for (const tr of toolResults) out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: textOf(tr.content) || String(tr.content ?? '') });
    if (rest.length) {
      const images = rest.filter((b) => b?.type === 'image');
      if (images.length) {
        const parts = rest.map((b) => {
          if (b.type === 'text') return { type: 'text', text: b.text };
          if (b.type === 'image') return { type: 'image_url', image_url: { url: `data:${b.source?.media_type || 'image/png'};base64,${b.source?.data || ''}` } };
          return null;
        }).filter(Boolean);
        out.push({ role: 'user', content: parts });
      } else {
        out.push({ role: 'user', content: textOf(rest) });
      }
    }
  }
  return out;
}

function translateAnthropicRequestToOpenAI(body) {
  const messages = [];
  const system = textOf(body?.system);
  if (system) messages.push({ role: 'system', content: system });
  messages.push(...anthropicMessagesToOpenAI(body?.messages));
  const out = {
    model: body?.model || 'local-gguf',
    messages,
    stream: body?.stream !== false,
    max_tokens: Number.isFinite(body?.max_tokens) ? body.max_tokens : 4096,
  };
  if (Number.isFinite(body?.temperature)) out.temperature = body.temperature;
  if (Array.isArray(body?.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;
  const tools = anthropicToolsToOpenAI(body?.tools); if (tools) out.tools = tools;
  const toolChoice = anthropicToolChoiceToOpenAI(body?.tool_choice); if (toolChoice !== undefined) out.tool_choice = toolChoice;
  return out;
}

const FINISH_REASON_MAP = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'end_turn' };

// One translator per request. Anthropic streams one content block at a time --
// a block must content_block_stop before the next one starts -- so this tracks
// a single "open" block (text or tool_use) and closes it before opening another.
function createAnthropicStreamTranslator({ model, id }) {
  let started = false, finished = false, openBlock = null, nextIndex = 0;
  const toolByOpenAiIndex = new Map();
  const frame = (type, data) => ({ event: type, data: { type, ...data } });
  const closeOpenBlock = (out) => { if (openBlock) { out.push(frame('content_block_stop', { index: openBlock.index })); openBlock = null; } };
  const ensureStarted = (out) => {
    if (started) return; started = true;
    out.push(frame('message_start', { message: { id, type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }));
  };
  function feed(chunk) {
    const out = [];
    if (finished) return out;
    ensureStarted(out);
    const choice = chunk?.choices?.[0];
    if (!choice) return out;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content) {
      if (!openBlock || openBlock.kind !== 'text') {
        closeOpenBlock(out); openBlock = { index: nextIndex++, kind: 'text' };
        out.push(frame('content_block_start', { index: openBlock.index, content_block: { type: 'text', text: '' } }));
      }
      out.push(frame('content_block_delta', { index: openBlock.index, delta: { type: 'text_delta', text: delta.content } }));
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const oaIndex = Number.isInteger(call.index) ? call.index : 0;
        let entry = toolByOpenAiIndex.get(oaIndex);
        if (!entry) {
          closeOpenBlock(out);
          entry = { index: nextIndex++, id: call.id || `call_${oaIndex}` };
          toolByOpenAiIndex.set(oaIndex, entry);
          openBlock = { index: entry.index, kind: 'tool' };
          out.push(frame('content_block_start', { index: entry.index, content_block: { type: 'tool_use', id: entry.id, name: call.function?.name || '', input: {} } }));
        }
        const args = call.function?.arguments;
        if (typeof args === 'string' && args) out.push(frame('content_block_delta', { index: entry.index, delta: { type: 'input_json_delta', partial_json: args } }));
      }
    }
    if (choice.finish_reason) {
      closeOpenBlock(out); finished = true;
      out.push(frame('message_delta', { delta: { stop_reason: FINISH_REASON_MAP[choice.finish_reason] || 'end_turn', stop_sequence: null }, usage: { output_tokens: chunk?.usage?.completion_tokens || 0 } }));
      out.push(frame('message_stop', {}));
    }
    return out;
  }
  function finish() {
    const out = [];
    if (finished) return out;
    ensureStarted(out); closeOpenBlock(out); finished = true;
    out.push(frame('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } }));
    out.push(frame('message_stop', {}));
    return out;
  }
  return { feed, finish };
}

function translateOpenAIResponseToAnthropic(resp, model) {
  const choice = resp?.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const call of msg.tool_calls || []) {
    let input = {}; try { input = JSON.parse(call.function?.arguments || '{}'); } catch {}
    content.push({ type: 'tool_use', id: call.id, name: call.function?.name, input });
  }
  return {
    id: resp?.id || 'msg_local', type: 'message', role: 'assistant', model,
    content, stop_reason: FINISH_REASON_MAP[choice.finish_reason] || 'end_turn', stop_sequence: null,
    usage: { input_tokens: resp?.usage?.prompt_tokens || 0, output_tokens: resp?.usage?.completion_tokens || 0 },
  };
}

// Loopback-only by default: this bridge exists to let Claude Code (also on
// loopback) reach llama-server's OpenAI endpoint, never to be reachable itself
// from the isolated Ethernet or any other host.
function startBridge({ port, upstreamBase, host = '127.0.0.1' }) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !/^\/v1\/messages/.test(req.url)) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Only POST /v1/messages is supported.' } })); }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 16 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON body.' } })); }
      let openaiBody;
      try { openaiBody = translateAnthropicRequestToOpenAI(parsed); } catch (error) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: error.message } })); }
      const payload = JSON.stringify(openaiBody);
      const upstreamUrl = new URL('/v1/chat/completions', upstreamBase);
      const upstreamReq = http.request(upstreamUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (upstreamRes) => {
        if (upstreamRes.statusCode !== 200) {
          let errText = ''; upstreamRes.on('data', (c) => (errText += c));
          upstreamRes.on('end', () => { res.writeHead(upstreamRes.statusCode || 502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `llama-server returned ${upstreamRes.statusCode}: ${errText.slice(0, 300)}` } })); });
          return;
        }
        if (!openaiBody.stream) {
          let text = ''; upstreamRes.setEncoding('utf8'); upstreamRes.on('data', (c) => (text += c));
          upstreamRes.on('end', () => {
            let parsedResp; try { parsedResp = JSON.parse(text); } catch { res.writeHead(502, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'llama-server returned an invalid response.' } })); }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(translateOpenAIResponseToAnthropic(parsedResp, openaiBody.model)));
          });
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const translator = createAnthropicStreamTranslator({ model: openaiBody.model, id: 'msg_' + crypto_randomId() });
        let buffer = '';
        const writeFrames = (frames) => { for (const f of frames) res.write(`event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`); };
        upstreamRes.setEncoding('utf8');
        upstreamRes.on('data', (chunk) => {
          buffer += chunk; let nl;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;
            let obj; try { obj = JSON.parse(data); } catch { continue; }
            writeFrames(translator.feed(obj));
          }
        });
        upstreamRes.on('end', () => { writeFrames(translator.finish()); res.end(); });
        upstreamRes.on('error', () => { try { res.end(); } catch {} });
      });
      upstreamReq.on('error', (error) => { try { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `Could not reach llama-server: ${error.message}` } })); } catch {} });
      upstreamReq.end(payload);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
function crypto_randomId() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

module.exports = { translateAnthropicRequestToOpenAI, createAnthropicStreamTranslator, translateOpenAIResponseToAnthropic, startBridge, selfcheck };

// ---- self-check -------------------------------------------------------------
function selfcheck() {
  return new Promise(async (resolve) => {
    let pass = 0, fail = 0;
    const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL', m); } };

    // 1. request translation: system, tool_result splitting, tools schema.
    (() => {
      const req = translateAnthropicRequestToOpenAI({
        model: 'local', max_tokens: 512, system: [{ type: 'text', text: 'Be terse.' }],
        tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'read a.txt' }] },
          { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a.txt' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }] },
        ],
      });
      ok(req.messages[0].role === 'system' && req.messages[0].content === 'Be terse.', 'system block -> system message');
      ok(req.messages[1].role === 'user' && req.messages[1].content === 'read a.txt', 'user text -> plain content');
      ok(req.messages[2].role === 'assistant' && req.messages[2].tool_calls?.[0]?.function.name === 'Read' && JSON.parse(req.messages[2].tool_calls[0].function.arguments).path === 'a.txt', 'tool_use -> tool_calls');
      ok(req.messages[3].role === 'tool' && req.messages[3].tool_call_id === 't1' && req.messages[3].content === 'file body', 'tool_result -> tool message');
      ok(req.tools[0].function.name === 'Read' && req.tools[0].function.parameters.properties.path.type === 'string', 'tool schema translated');
    })();

    // 2. streaming translator: text then a tool call then finish, in order.
    (() => {
      const t = createAnthropicStreamTranslator({ model: 'local', id: 'msg_1' });
      const frames = [
        ...t.feed({ choices: [{ delta: { content: 'Hi ' } }] }),
        ...t.feed({ choices: [{ delta: { content: 'there' } }] }),
        ...t.feed({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Bash', arguments: '' } }] } }] }),
        ...t.feed({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":' } }] } }] }),
        ...t.feed({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] } }] }),
        ...t.feed({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { completion_tokens: 9 } }),
      ];
      const types = frames.map((f) => f.event);
      ok(types[0] === 'message_start', 'stream starts with message_start');
      ok(types.includes('content_block_start') && types.includes('content_block_delta'), 'text block streamed');
      const textStop = frames.findIndex((f) => f.event === 'content_block_stop');
      const toolStart = frames.findIndex((f) => f.event === 'content_block_start' && f.data.content_block?.type === 'tool_use');
      ok(textStop >= 0 && toolStart > textStop, 'text block closes before tool_use block opens');
      ok(frames[toolStart].data.content_block.name === 'Bash' && frames[toolStart].data.index === 1, 'tool_use block carries name at index 1');
      const argDeltas = frames.filter((f) => f.event === 'content_block_delta' && f.data.delta?.type === 'input_json_delta').map((f) => f.data.delta.partial_json).join('');
      ok(argDeltas === '{"command":"ls"}', 'tool arguments reassemble from fragments');
      ok(types[types.length - 1] === 'message_stop' && types[types.length - 2] === 'message_delta', 'stream ends with message_delta then message_stop');
      ok(frames.find((f) => f.event === 'message_delta').data.delta.stop_reason === 'tool_use', 'finish_reason tool_calls -> stop_reason tool_use');
    })();

    // 3. end-to-end over real loopback sockets: fake llama-server -> bridge -> raw SSE parse.
    const fakeUpstream = http.createServer((req, res) => {
      let body = ''; req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        ok(parsed.messages.some((m) => m.role === 'system'), 'upstream received translated system message');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 1 } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    await new Promise((r) => fakeUpstream.listen(0, '127.0.0.1', r));
    const upstreamBase = `http://127.0.0.1:${fakeUpstream.address().port}`;
    const bridge = await startBridge({ port: 0, upstreamBase, host: '127.0.0.1' });
    const bridgePort = bridge.address().port;
    const reqBody = JSON.stringify({ model: 'local', max_tokens: 64, system: 'test', stream: true, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
    const raw = await new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: bridgePort, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(reqBody) } }, (res) => {
        let data = ''; res.setEncoding('utf8'); res.on('data', (c) => (data += c)); res.on('end', () => resolve(data));
      });
      r.on('error', reject); r.end(reqBody);
    });
    ok(raw.includes('event: message_start'), 'bridge SSE includes message_start');
    ok(raw.includes('"text":"Hello"') || raw.includes('"text_delta"'), 'bridge SSE carries translated text delta');
    ok(raw.trim().endsWith('data: {"type":"message_stop"}'), 'bridge SSE ends with message_stop');
    await new Promise((r) => bridge.close(r));
    await new Promise((r) => fakeUpstream.close(r));

    console.log('llamacpp-bridge selfcheck:', pass, 'passed,', fail, 'failed');
    resolve(!fail);
  });
}
if (require.main === module) selfcheck().then((r) => process.exit(r ? 0 : 1));
