// Engine registry: which agent harness drives a turn, and what a turn is
// allowed to touch.  Axon owns the product; the engine is a swappable adapter.
//
// Two axes that used to be one field.  `provider.kind` is the model route
// (where tokens come from); `provider.engine` is the harness (what runs the
// agent loop).  Collapsing them into a single `kind` is what produced the
// invalid combinations that failed at inference time -- Ollama Cloud rejecting
// Codex's freeform tool schema, Claude Code needing an Anthropic-shaped
// endpoint.  `engineSupportsProvider` states those rules once instead of
// re-deriving them at each call site.

// A single scope control replaces the old Chat/Code/Work modes.  The modes
// only ever encoded two booleans (workspace tools on/off, delegation on/off)
// but cost a three-way surface split.  Scope keeps the same capability
// contract -- `productMode` and `permission` still drive capabilities.js and
// the native loop unchanged -- while the UI shows one conversation.
const SCOPES = {
  chat: {
    id: 'chat',
    label: 'Just chat',
    hint: 'Direct conversation. No workspace, browser, or task execution.',
    productMode: 'chat',
    permission: 'approve',
    usesEngine: false,
  },
  read: {
    id: 'read',
    label: 'Read workspace',
    hint: 'Can read files and browse. Never edits or runs mutating commands.',
    productMode: 'code',
    permission: 'approve',
    usesEngine: true,
  },
  edit: {
    id: 'edit',
    label: 'Edit files',
    hint: 'Can edit files and run commands in the selected workspace.',
    productMode: 'code',
    permission: 'auto',
    usesEngine: true,
  },
  full: {
    id: 'full',
    label: 'Full access',
    hint: 'Edits without asking and can delegate focused sub-tasks.',
    productMode: 'agent',
    permission: 'full',
    usesEngine: true,
  },
};
const SCOPE_ORDER = ['chat', 'read', 'edit', 'full'];

function normalizeScope(value) {
  return SCOPE_ORDER.includes(value) ? value : 'chat';
}
function scopeInfo(value) {
  return SCOPES[normalizeScope(value)];
}
// Back-compat: a saved conversation or an older settings file still carries
// productMode/permissionMode.  Recover the nearest scope so upgrading does not
// silently drop a user into 'chat'.
function scopeFromLegacy(productMode, permissionMode) {
  if (productMode === 'agent') return 'full';
  if (productMode === 'code') return permissionMode === 'approve' ? 'read' : 'edit';
  return 'chat';
}

// `providers` lists the model routes an engine can actually drive.  Anything
// absent is refused before spawn with `engineRefusal`'s reason rather than
// failing mid-turn with a provider protocol error.
const ENGINES = {
  none: {
    id: 'none',
    label: 'Axon native',
    hint: "Axon's own tool loop over Ollama's function calls. No external CLI.",
    binary: null,
    schema: 'native',
    providers: ['ollama'],
  },
  qwen: {
    id: 'qwen',
    label: 'Qwen Code',
    hint: 'Official Qwen Code CLI. Points at any OpenAI-compatible endpoint.',
    binary: 'qwen',
    schema: 'stream-json',
    providers: ['ollama', 'openai-compatible'],
  },
  claude: {
    id: 'claude',
    label: 'Claude Code',
    hint: 'Official Claude Code CLI. Needs an Anthropic-compatible route.',
    binary: 'claude',
    schema: 'stream-json',
    providers: ['ollama'],
  },
  codex: {
    id: 'codex',
    label: 'Codex CLI',
    hint: 'Official Codex CLI. Needs a Responses-compatible route.',
    binary: 'codex',
    schema: 'codex-json',
    providers: ['ollama', 'responses'],
  },
};
const ENGINE_ORDER = ['qwen', 'claude', 'codex', 'none'];
const PROVIDER_KINDS = ['ollama', 'openai-compatible', 'responses'];

function normalizeEngine(value) {
  return Object.prototype.hasOwnProperty.call(ENGINES, value) ? value : 'qwen';
}
function normalizeProviderKind(value) {
  return PROVIDER_KINDS.includes(value) ? value : 'ollama';
}
function engineInfo(value) {
  return ENGINES[normalizeEngine(value)];
}
function engineSupportsProvider(engineId, providerKind) {
  return engineInfo(engineId).providers.includes(normalizeProviderKind(providerKind));
}
// One sentence a user can act on, rather than a raw protocol error.
function engineRefusal(engineId, providerKind) {
  if (engineSupportsProvider(engineId, providerKind)) return null;
  const engine = engineInfo(engineId);
  const routes = engine.providers.map((kind) => PROVIDER_LABELS[kind] || kind).join(' or ');
  return `${engine.label} cannot run on ${PROVIDER_LABELS[normalizeProviderKind(providerKind)]}. It needs ${routes}.`;
}
const PROVIDER_LABELS = {
  ollama: 'Ollama',
  'openai-compatible': 'an OpenAI-compatible API',
  responses: 'a Responses-compatible API',
};

// The old single field mixed route and harness.  Map the retired values onto
// the pair they always meant so saved profiles survive the upgrade.
const LEGACY_KINDS = {
  'codex-cli': { kind: 'ollama', engine: 'codex' },
  'claude-cli': { kind: 'ollama', engine: 'claude' },
};
function migrateProvider(profile) {
  if (!profile || typeof profile !== 'object') return profile;
  const legacy = LEGACY_KINDS[profile.kind];
  if (legacy) return { ...profile, kind: legacy.kind, engine: legacy.engine };
  return {
    ...profile,
    kind: normalizeProviderKind(profile.kind),
    engine: normalizeEngine(profile.engine ?? 'none'),
  };
}

// Resolve one turn to the runner that should execute it.  `native` covers both
// local and `:cloud` Ollama models -- it is Ollama's own function-call loop,
// not a cloud-only path.
function resolveRoute({ scope, engine, providerKind }) {
  const info = scopeInfo(scope);
  if (!info.usesEngine) return { runner: 'direct', scope: info, engine: 'none', reason: null };
  const selected = normalizeEngine(engine);
  const refusal = engineRefusal(selected, providerKind);
  if (refusal) return { runner: 'refused', scope: info, engine: selected, reason: refusal };
  return { runner: engineInfo(selected).schema === 'native' ? 'native' : selected, scope: info, engine: selected, reason: null };
}

module.exports = {
  SCOPES, SCOPE_ORDER, ENGINES, ENGINE_ORDER, PROVIDER_KINDS, PROVIDER_LABELS,
  normalizeScope, scopeInfo, scopeFromLegacy,
  normalizeEngine, normalizeProviderKind, engineInfo, engineSupportsProvider, engineRefusal,
  migrateProvider, resolveRoute,
};
