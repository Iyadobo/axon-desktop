// Native Ollama function-call loop used when Codex Responses freeform tools
// are not accepted by an Ollama Cloud model.  It deliberately owns only the
// standard tool protocol; the desktop shell still owns UI, browser and policy.
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const crypto = require('crypto');
const sessions = new Map();
const DEFAULT_CLOUD_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

const tools = [
  { type: 'function', function: { name: 'run_command', description: 'Run a command in the current workspace. Inspect before changing files and verify changes.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'browser_open', description: 'Open an http(s) page in the visible Axon Browser.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'browser_read', description: 'Read visible page text and labelled controls from Axon Browser.', parameters: { type: 'object', properties: {} } } },
];
const delegateTool = { type: 'function', function: { name: 'delegate_task', description: 'Delegate one bounded, independent subtask. It uses the current model unless model is explicitly supplied. Do not delegate tasks that need the parent conversation context.', parameters: { type: 'object', properties: { task: { type: 'string' }, model: { type: 'string', description: 'Optional Ollama model override.' } }, required: ['task'] } } };

function cloudIdleTimeoutMs(value = process.env.AXON_OLLAMA_CLOUD_IDLE_TIMEOUT_MS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_CLOUD_IDLE_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(parsed), 30000), 30 * 60 * 1000);
}

function mergeChatChunk(state, chunk, onContent) {
  if (!chunk || typeof chunk !== 'object') return state;
  const message = chunk.message && typeof chunk.message === 'object' ? chunk.message : null;
  const content = typeof message?.content === 'string' ? message.content : '';
  if (content) onContent?.(content);
  return {
    ...state,
    ...chunk,
    message: message ? {
      ...(state.message || {}),
      ...message,
      content: `${state.message?.content || ''}${content}`,
      tool_calls: [
        ...(Array.isArray(state.message?.tool_calls) ? state.message.tool_calls : []),
        ...(Array.isArray(message.tool_calls) ? message.tool_calls : []),
      ],
    } : state.message,
  };
}

function request(url, body, holder, { idleTimeoutMs = cloudIdleTimeoutMs(), onContent } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL('/api/chat', url);
    const client = target.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);
    const req = client.request(target, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
      let buffer = '', response = {};
      const consume = (line) => {
        if (!line.trim()) return;
        response = mergeChatChunk(response, JSON.parse(line), onContent);
      };
      res.setEncoding('utf8');
      res.on('data', (part) => {
        buffer += part;
        if (res.statusCode !== 200) return;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          try { consume(line); } catch (error) { req.destroy(error); }
        }
      });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            let data = {}; try { data = JSON.parse(buffer); } catch {}
            const error = new Error(data.error?.message || data.error || buffer || `Ollama returned ${res.statusCode}`);
            error.statusCode = res.statusCode;
            error.retryable = RETRYABLE_STATUS_CODES.has(res.statusCode);
            throw error;
          }
          consume(buffer);
          resolve(response);
        } catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    holder.child = req;
    req.setTimeout(idleTimeoutMs, () => req.destroy(new Error(`Ollama Cloud was quiet for ${Math.round(idleTimeoutMs / 60000)} minute${idleTimeoutMs === 60000 ? '' : 's'}. The model may be overloaded; retry the run.`)));
    req.on('error', reject);
    req.end(payload);
  });
}

async function requestWithRetry(url, body, holder, options = {}) {
  const attempts = options.attempts ?? 2;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { return await request(url, body, holder, options); }
    catch (error) {
      // Only retry an explicit pre-generation gateway response. A timeout,
      // partial stream, or user Stop may already have started work remotely.
      if (!error.retryable || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 750));
    }
  }
  throw new Error('Ollama Cloud request failed.');
}

// Heuristic guard for Swarm's read-only workers. run_command is a raw shell,
// so there is no true sandbox here -- this blocks the shapes of command that
// write, delete, or move things, on both Windows (cmd.exe) and POSIX shells.
// It is a denylist, not a proof: treat it as a real backstop, not a sandbox.
const MUTATING_COMMAND = /(^|[;&|\n]|&&|\|\|)\s*(rm|rmdir|rd|del|erase|mv|move|ren|rename|cp\b.*-r|xcopy|robocopy|mkdir|md|touch|chmod|chown|attrib|icacls|sed\s+-i|git\s+(add|commit|push|reset|checkout|rm|clean|stash|merge|rebase|apply|cherry-pick)|npm\s+(install|i\b|uninstall|ci|link)|pip\s+install|pip3\s+install|yarn\s+add|yarn\s+remove|pnpm\s+(add|remove|install)|winget\s+install|choco\s+install)\b/i;
const WRITE_REDIRECT = />>?[^&|]|(?:^|\s)tee\s/;
function isMutatingCommand(cmd) {
  return MUTATING_COMMAND.test(cmd) || WRITE_REDIRECT.test(cmd);
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

async function runOllamaCloudAgent({ endpoint, model, prompt, sessionId, history = [], systemPrompt, cwd, permissionMode, productMode, send, holder, browser, allowDelegation = productMode === 'agent', onSubagent, readOnly = false }) {
  const sid = sessionId || crypto.randomUUID();
  const previous = sessions.get(sid);
  const recovered = Array.isArray(history) ? history.filter((item) => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string').slice(-40) : [];
  const messages = previous ? [...previous, { role: 'user', content: prompt }] : [{ role: 'system', content: [systemPrompt, productMode === 'agent' ? 'You are Axon Work. Complete the outcome in small verified steps.' : 'You are Axon Code. Work carefully in the current repository and verify changes.'].filter(Boolean).join('\n\n') }, ...recovered, { role: 'user', content: prompt }];
  for (let turn = 0; turn < 12; turn++) {
    const response = await requestWithRetry(endpoint, { model, messages, tools: allowDelegation ? [...tools, delegateTool] : tools, stream: true }, holder, { onContent: (content) => send('chat-delta', content) });
    const message = response.message || {};
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (!calls.length) { sessions.set(sid, messages.concat(message).slice(-80)); return sid; }
    messages.push(message);
    for (const call of calls) {
      const fn = call.function?.name; const args = call.function?.arguments || {};
      send('chat-step', { type: 'tool_call', fn, args });
      let result;
      try {
        if (fn === 'run_command') {
          const cmd = String(args.command || '');
          if (permissionMode === 'approve') result = { error: 'Command execution needs Auto or Full permission in Axon.' };
          else if (readOnly && isMutatingCommand(cmd)) result = { error: 'This Swarm worker is read-only: write/delete/move commands are blocked. Report the proposed change instead of applying it.' };
          else result = await command(cmd, cwd);
        }
        else if (fn === 'browser_open') result = browser.open(args.url);
        else if (fn === 'browser_read') result = await browser.read();
        else if (fn === 'delegate_task') {
          const childModel = typeof args.model === 'string' && args.model.trim() ? args.model.trim().slice(0, 160) : model;
          const childId = crypto.randomUUID(); onSubagent?.({ id: childId, status: 'working', task: String(args.task || '').slice(0, 240), model: childModel, startedAt: Date.now() });
          let response = '';
          try { await runOllamaCloudAgent({ endpoint, model: childModel, prompt: String(args.task || '').slice(0, 12000), systemPrompt: `${systemPrompt || ''}\n\nYou are a focused Axon subagent. Return concise findings to your parent.`, cwd, permissionMode, productMode: 'code', send: (kind, value) => { if (kind === 'chat-delta') response += value; }, holder: {}, browser, allowDelegation: false, readOnly }); result = { model: childModel, response: response.slice(0, 16000) || '(subagent completed without a text summary)' }; onSubagent?.({ id: childId, status: 'completed', result: result.response, finishedAt: Date.now() }); }
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

module.exports = { runOllamaCloudAgent, requestWithRetry, cloudIdleTimeoutMs };
