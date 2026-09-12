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
    { name: 'browser_open', description: 'Open a safe http(s) URL in the visible NoCLI.ai Browser sidebar and wait for it to finish loading.', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
    { name: 'browser_read', description: 'Read the page as structured text plus interactable controls (id, role, name, value, disabled, checked, dialog, inView). Traverses shadow DOM and same-origin iframes. Call this before clicking; popup/dialog controls are marked dialog:true.', inputSchema: { type: 'object', properties: {} } },
    { name: 'browser_find', description: 'Search the current page for controls/text containing a string; returns matching element ids. Faster than reading the whole page.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    { name: 'browser_point', description: 'Move the visible browser cursor onto an element id, without clicking. Use to show which control you mean, or before a screenshot.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    { name: 'browser_click', description: 'Click an element id via a real mouse event (works on custom widgets that ignore synthetic clicks). The visible cursor moves and pulses.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    { name: 'browser_type', description: 'Focus an input/textarea/contenteditable by id and type real text into it (replaces existing text).', inputSchema: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] } },
    { name: 'browser_press', description: 'Press a key such as Enter, Escape, Tab, or ArrowDown on the focused element.', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
    { name: 'browser_scroll', description: 'Scroll the page down or up (default 700px) to reveal more content.', inputSchema: { type: 'object', properties: { direction: { type: 'string', enum: ['down', 'up'] }, amount: { type: 'number' } } } },
    { name: 'browser_wait', description: 'Wait until the given text appears on the page (for async content or popups), up to timeout ms (default 8000).', inputSchema: { type: 'object', properties: { text: { type: 'string' }, timeout: { type: 'number' } }, required: ['text'] } },
    { name: 'browser_dismiss', description: 'Dismiss a popup/cookie banner: presses Escape then clicks the first visible close/dismiss/accept control. Use when browser_read reports a dialog.', inputSchema: { type: 'object', properties: {} } },
    { name: 'web_search', description: 'Search the web (DuckDuckGo) and return result titles, URLs and snippets. Each result is added to the shared source list with an id you can cite. Use this before browser_open/browser_read.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
    { name: 'web_fetch', description: 'Fetch a URL and return its main readable text plus a source id, without opening the browser panel. Prefer this over browser_read for research; it is faster.', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
    { name: 'library_search', description: 'Search the user\'s local research library (folders they added) and return matching files with a snippet and source id.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
    { name: 'library_status', description: 'List the local research library folders and how many documents are indexed.', inputSchema: { type: 'object', properties: {} } },
    { name: 'sources', description: 'List every source gathered this session (web and local files) with its id, title and URL/path — use these ids for citations.', inputSchema: { type: 'object', properties: {} } },
    { name: 'browser_screenshot', description: 'Capture a screenshot only when visual inspection is necessary and the model supports vision. Text-only models should use browser_read instead.', inputSchema: { type: 'object', properties: {} } },
  ];
}
async function handle(message) {
  const { id, method, params = {} } = message;
  if (method === 'initialize') return reply(id, { protocolVersion: params.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'nocli-browser', version: '0.1.0' } });
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') return reply(id, { tools: tools() });
  if (method !== 'tools/call') return fail(id, 'Unsupported MCP method.');
  const action = { browser_open: 'open', browser_read: 'read', browser_find: 'find', browser_point: 'point', browser_click: 'click', browser_type: 'type', browser_press: 'press', browser_scroll: 'scroll', browser_wait: 'wait', browser_dismiss: 'dismiss', web_search: 'search', web_fetch: 'fetch', library_search: 'library-search', library_status: 'library-status', sources: 'sources', browser_screenshot: 'screenshot' }[params.name];
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
