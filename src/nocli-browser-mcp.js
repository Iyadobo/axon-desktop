// NoCLI.ai Browser MCP bridge. It speaks JSON-RPC over stdio and forwards only to
// the local Electron main process; it never owns a browser profile itself.
const endpoint = process.env.NOCLI_BROWSER_ENDPOINT;
const token = process.env.NOCLI_BROWSER_TOKEN;

function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
function fail(id, message) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }) + '\n'); }
async function call(action, payload = {}) {
  if (!endpoint || !token) throw new Error('NoCLI.ai Browser is unavailable for this session.');
  const response = await fetch(endpoint + '/' + action, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-nocli-browser-token': token }, body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || 'Browser action failed.');
  return data;
}
function tools() {
  return [
    { name: 'browser_open', description: 'Open a safe http(s) URL in the visible NoCLI.ai Browser sidebar.', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
    { name: 'browser_read', description: 'Read the current page as structured text and interactable controls. Use this before clicking. Screenshots are intentionally not returned.', inputSchema: { type: 'object', properties: {} } },
    { name: 'browser_click', description: 'Click an element ID returned by browser_read.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    { name: 'browser_type', description: 'Type text into an input element ID returned by browser_read.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] } },
    { name: 'browser_screenshot', description: 'Capture a screenshot only when visual inspection is necessary and the assigned model supports vision.', inputSchema: { type: 'object', properties: {} } },
  ];
}
async function handle(message) {
  const { id, method, params = {} } = message;
  if (method === 'initialize') return reply(id, { protocolVersion: params.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'nocli-browser', version: '0.1.0' } });
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') return reply(id, { tools: tools() });
  if (method !== 'tools/call') return fail(id, 'Unsupported MCP method.');
  const action = { browser_open: 'open', browser_read: 'read', browser_click: 'click', browser_type: 'type', browser_screenshot: 'screenshot' }[params.name];
  if (!action) return fail(id, 'Unknown browser tool.');
  try {
    if (action === 'screenshot' && process.env.NOCLI_BROWSER_ALLOW_SCREENSHOT !== '1') {
      throw new Error('Screenshots are disabled for this text-only model. Use browser_read, or choose a vision-capable model for visual inspection.');
    }
    const result = await call(action, params.arguments || {});
    if (action === 'screenshot') return reply(id, { content: [{ type: 'image', data: result.data, mimeType: result.mimeType || 'image/png' }] });
    return reply(id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
  } catch (error) { return fail(id, error.message); }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk; let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch (error) { fail(null, error.message); }
  }
});
