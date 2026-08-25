// Native Ollama function-call loop used when Codex Responses freeform tools
// are not accepted by an Ollama Cloud model.  It deliberately owns only the
// standard tool protocol; the desktop shell still owns UI, browser and policy.
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const crypto = require('crypto');
const sessions = new Map();

const tools = [
  { type: 'function', function: { name: 'run_command', description: 'Run a command in the current workspace. Inspect before changing files and verify changes.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'browser_open', description: 'Open an http(s) page in the visible Axon Browser.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'browser_read', description: 'Read visible page text and labelled controls from Axon Browser.', parameters: { type: 'object', properties: {} } } },
];
const delegateTool = { type: 'function', function: { name: 'delegate_task', description: 'Delegate one bounded, independent subtask. It uses the current model unless model is explicitly supplied. Do not delegate tasks that need the parent conversation context.', parameters: { type: 'object', properties: { task: { type: 'string' }, model: { type: 'string', description: 'Optional Ollama model override.' } }, required: ['task'] } } };

function request(url, body, holder) {
  return new Promise((resolve, reject) => {
    const target = new URL('/api/chat', url);
    const client = target.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);
    const req = client.request(target, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (part) => { text += part; });
      res.on('end', () => { try { const data = JSON.parse(text); if (res.statusCode !== 200) throw new Error(data.error?.message || text || `Ollama returned ${res.statusCode}`); resolve(data); } catch (error) { reject(error); } });
    });
    holder.child = req; req.setTimeout(120000, () => req.destroy(new Error('Ollama Cloud timed out.'))); req.on('error', reject); req.end(payload);
  });
}

function command(command, cwd) {
  return new Promise((resolve) => {
    const child = process.platform === 'win32'
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], { cwd, windowsHide: true })
      : spawn('/bin/sh', ['-lc', command], { cwd });
    let output = ''; const add = (chunk) => { output = (output + chunk).slice(-32000); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    const timer = setTimeout(() => child.kill(), 60000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code, output: output || '(no output)' }); });
    child.on('error', (error) => { clearTimeout(timer); resolve({ error: error.message }); });
  });
}

async function runOllamaCloudAgent({ endpoint, model, prompt, sessionId, systemPrompt, cwd, permissionMode, productMode, send, holder, browser, allowDelegation = productMode === 'agent', onSubagent }) {
  const sid = sessionId || crypto.randomUUID();
  const previous = sessions.get(sid);
  const messages = previous ? [...previous, { role: 'user', content: prompt }] : [{ role: 'system', content: [systemPrompt, productMode === 'agent' ? 'You are Axon Work. Complete the outcome in small verified steps.' : 'You are Axon Code. Work carefully in the current repository and verify changes.'].filter(Boolean).join('\n\n') }, { role: 'user', content: prompt }];
  for (let turn = 0; turn < 12; turn++) {
    const response = await request(endpoint, { model, messages, tools: allowDelegation ? [...tools, delegateTool] : tools, stream: false }, holder);
    const message = response.message || {};
    if (message.content) send('chat-delta', message.content);
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (!calls.length) { sessions.set(sid, messages.concat(message).slice(-80)); return sid; }
    messages.push(message);
    for (const call of calls) {
      const fn = call.function?.name; const args = call.function?.arguments || {};
      send('chat-step', { type: 'tool_call', fn, args });
      let result;
      try {
        if (fn === 'run_command') result = permissionMode === 'approve' ? { error: 'Command execution needs Auto or Full permission in Axon.' } : await command(String(args.command || ''), cwd);
        else if (fn === 'browser_open') result = browser.open(args.url);
        else if (fn === 'browser_read') result = await browser.read();
        else if (fn === 'delegate_task') {
          const childModel = typeof args.model === 'string' && args.model.trim() ? args.model.trim().slice(0, 160) : model;
          const childId = crypto.randomUUID(); onSubagent?.({ id: childId, status: 'working', task: String(args.task || '').slice(0, 240), model: childModel, startedAt: Date.now() });
          let response = '';
          try { await runOllamaCloudAgent({ endpoint, model: childModel, prompt: String(args.task || '').slice(0, 12000), systemPrompt: `${systemPrompt || ''}\n\nYou are a focused Axon subagent. Return concise findings to your parent.`, cwd, permissionMode, productMode: 'code', send: (kind, value) => { if (kind === 'chat-delta') response += value; }, holder: {}, browser, allowDelegation: false }); result = { model: childModel, response: response.slice(0, 16000) || '(subagent completed without a text summary)' }; onSubagent?.({ id: childId, status: 'completed', result: result.response, finishedAt: Date.now() }); }
          catch (error) { onSubagent?.({ id: childId, status: 'failed', result: error.message, finishedAt: Date.now() }); throw error; }
        }
        else result = { error: `Unknown tool: ${fn}` };
      } catch (error) { result = { error: error.message }; }
      send('chat-step', { type: 'tool_result', result: typeof result === 'string' ? result : JSON.stringify(result).slice(0, 12000) });
      messages.push({ role: 'tool', content: JSON.stringify(result) });
    }
  }
  throw new Error('Axon Cloud agent stopped after 12 tool rounds. Ask it to continue with a narrower task.');
}

module.exports = { runOllamaCloudAgent };
