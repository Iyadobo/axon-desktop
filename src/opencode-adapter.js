// Pure OpenCode launch configuration. Keeping this separate lets the self-check
// verify route/model/permission behavior without loading Electron's main process.
function openCodePermission(scope) {
  if (scope === 'full') return { '*': 'allow' };
  if (scope === 'edit') return { '*': 'allow', task: 'deny', external_directory: 'deny' };
  if (scope === 'read') {
    return {
      '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow',
      lsp: 'allow', webfetch: 'allow', websearch: 'allow',
    };
  }
  return { '*': 'deny' };
}

function openCodeLaunchConfig({ provider, model, scope, apiKey }) {
  const kind = provider?.kind || 'ollama';
  const requestedModel = String(model || provider?.model || '').trim();
  if (!requestedModel) throw new Error('Choose a model before starting an OpenCode turn.');
  const config = {
    $schema: 'https://opencode.ai/config.json',
    agent: {
      nocli: {
        description: 'NoCLI.ai desktop conversation engine',
        mode: 'primary',
        permission: openCodePermission(scope),
      },
    },
  };
  let launchModel = requestedModel;
  const env = {};
  if (kind !== 'opencode') {
    const id = kind === 'ollama' ? 'nocli-ollama' : 'nocli-api';
    const baseURL = kind === 'ollama'
      ? String(provider?.endpoint || 'http://127.0.0.1:11434/v1').replace(/\/$/, '')
      : String(provider?.endpoint || '').replace(/\/$/, '');
    if (!baseURL) throw new Error('This OpenCode route needs an API endpoint.');
    env.NOCLI_OPENCODE_API_KEY = apiKey || (kind === 'ollama' ? 'ollama' : '');
    config.provider = {
      [id]: {
        npm: '@ai-sdk/openai-compatible',
        name: kind === 'ollama' ? 'NoCLI.ai Ollama' : (provider?.name || 'NoCLI.ai API'),
        options: { baseURL, apiKey: '{env:NOCLI_OPENCODE_API_KEY}' },
        models: { [requestedModel]: { name: requestedModel } },
      },
    };
    launchModel = `${id}/${requestedModel}`;
  }
  return { config, env, launchModel };
}

module.exports = { openCodePermission, openCodeLaunchConfig };
