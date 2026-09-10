# NoCLI.ai Terminal migration map
Audit of the current Electron app (25 Aug 2026). This is a read-only inventory;
no existing source was changed. “NoCLI.ai Terminal” below means the target native
terminal/agent runtime and its private CLI contract, not a currently existing
module in this checkout.

## Coupling inventory

| Current location | Exact coupling | Coupling type | NoCLI.ai Terminal replacement | Priority |
|---|---|---|---|---|
| `package.json:4,7-10,45-46`; `src/main.js:1-2,351-373` | Electron owns the window, tray, preload, and process lifecycle | Shell/UI host | Keep Electron as a thin UI host; move agent process/session ownership behind an NoCLI.ai Terminal service | P1 |
| `src/main.js:33,41-43,183-206` (`LOCAL_OLLAMA_URL`, `activeOllamaUrl`, `activeClaudeBase`, `ensureOllama`, `ollama`) | Starts `ollama serve`, probes `/api/tags`, and assumes Ollama/Anthropic-compatible loopback endpoints | Runtime/provider | NoCLI.ai Terminal runtime supervisor and provider-neutral model/session API; retain Ollama only as an optional provider adapter | P0 |
| `src/main.js:106-155` (`findClaude`, `findCodex`, `findOpencode`); `:157-178` (`runQuiet`, `dependencyStatus`) | Discovers host-installed executables and runs `--version`; Codex also runs `login status` | External CLI/process + account state | Resolve one packaged/user-scoped `nocli-terminal` executable; expose capability/auth status through its API, never by probing unrelated CLIs | P0 |
| `src/main.js:544-633` (`runChat`) | Spawns `claude -p`, `--resume`, `--allowedTools`, permission mode, `--append-system-prompt`; sets `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN=ollama` | Primary agent harness, prompt, session, credentials/env | NoCLI.ai Terminal `turn.start`/`session.resume` request with structured system instructions, policy, tools, images, cwd; Terminal owns provider credentials and session persistence | P0 |
| `src/main.js:635-677` (`runCodex`) | Spawns `codex exec --json`, maps `thread.started`, command execution, agent messages, failures; inherits process environment | Optional harness + account/session | Remove as a selectable harness; if compatibility is needed, implement Codex import/export in Terminal, with isolated credentials and explicit session migration | P1 |
| `src/main.js:683-735` (`runOpencode`), `src/oc.js:1-73` | Spawns `opencode run --format json`; maps cumulative text, reasoning, settled tools, session ID | Optional harness + config/account implicit in CLI | Terminal adapter for the same normalized event stream; no direct opencode launch from Electron | P1 |
| `src/main.js:470-526` (`NOCLI_IDENTITY_PROMPT`, `permissionPrompt`, `nocliSystemPrompt`) | NoCLI.ai identity/policy is concatenated into Claude's system prompt; permission enforcement relies on each harness's flags | System prompt + policy semantics | Move canonical identity/policy into `NOCLI.md` plus a structured Terminal policy object. Keep user/project instructions as a separate field; do not duplicate identity per harness | P0 |
| `src/commands.js:11-72` (`COMMAND_DIRS`, `maybeExpandSlash`, `listCommands`) and `src/main.js:460-466` | Explicitly reads `~/.claude/commands` and `<cwd>/.claude/commands`; expands Markdown commands because Claude headless mode does not | Host config/content path | Read only `$NOCLI_HOME/commands` and `<workspace>/.nocli/commands` (or Terminal command registry). Never read `~/.claude` implicitly | P0 |
| `src/main.js:1289-1315` (`fetchCommands`) | Starts a throwaway Claude process to obtain `system/init.slash_commands`; uses Ollama endpoint and default model | Harness discovery | Terminal returns command catalog directly (`commands.list`); no hidden model call | P1 |
| `src/cc.js:13-43` (`parseEvent`) | Claude `stream-json` schema is translated to `{act:'delta'|'step'|'done'}` | Protocol parser | Replace with Terminal event decoder; retain this normalized flow as a compatibility fixture during migration | P0 |
| `src/preload.js:2-62`; `src/renderer/app.js:1358-1375,1454-1497` | Renderer API is named `window.nocli`; `chat` carries model/prompt/session/systemPrompt/cwd/images/harness/mode/grants | IPC/API naming and request shape | Rename bridge to `window.nocliTerminal`; preserve request fields initially, adding `provider`, `policy`, and `workspaceId` | P0 |
| `src/config.js:4-43`; `src/main.js:1319-1340` | Settings stored under Electron `userData/settings.json`; startup merges sibling `nocli/settings.json` and `ollama-desktop-harness/settings.json` | Persistence/migration | Store Terminal state under `$NOCLI_HOME/state/` (settings, sessions index, audit log); one explicit import migration, then stop reading predecessor paths | P0 |
| `src/main.js:570,648,698,1295` (`env: {...process.env,...}`) | Child processes inherit all host environment, including HOME/USERPROFILE and possible provider tokens/config selectors | Isolation/credential leakage | Spawn Terminal with a minimal allowlist env: `NOCLI_HOME`, workspace, locale, PATH to bundled tools, and explicit provider endpoint/token handle | P0 |
| `src/main.js:1274-1281` (`install-dependencies`) | Installs Ollama/Node/Claude Code via winget/npm; messages make those dependencies mandatory | Installer/dependency coupling | Install/update NoCLI.ai Terminal only; providers are optional, declared capabilities, and never installed through arbitrary shell/npm | P1 |
| `src/main.js:256-285,810-814`; `src/renderer/app.js:350-416,670-697` | Ollama model catalogue, pull API, model metadata, vision checks, and Ollama-branded UI | Provider-specific model management | Terminal `models.list`/`models.pull` capability, or provider UI plugin; remove Ollama assumptions from core UI | P1 |
| `src/llamacpp-bridge.js`, `src/llamacpp-runtime.js`, `src/main.js:38-75,740-805` | Anthropic⇄OpenAI bridge exists solely so Claude Code can speak to llama.cpp | Compatibility adapter | Terminal speaks provider-neutral protocol directly; keep bridge only as an optional provider module | P2 |
| `src/lan.js`, `src/main.js:911-1230` | LAN server/client forwards chat messages and the current harness/session model | Remote transport | Forward Terminal request/event envelopes, with explicit peer capabilities and no credential forwarding | P1 |
| `README.md:6-28,36-46,71-90,160-178`; `src/renderer/index.html:833-865,921-930` | Product copy, settings labels, dependency checks, and model picker describe Claude Code/Ollama as the product | UX/documentation coupling | Rewrite around NoCLI.ai Terminal as the runtime; show provider/harness adapters as implementation details | P1 |
| `src/selfcheck.js:1-2,56-106,120-131,158-159`; `scripts/preview-preload.js:1-15`; `src/renderer/model-logos.js:42` | Tests, preview stubs, and branding assume Claude/Ollama/opencode and `window.nocli` | Test/tooling/branding | Add Terminal NDJSON fixtures and an isolated temp `NOCLI_HOME`; retain old parser tests only during transition | P1 |

### MCP, credentials, and system-prompt findings

- No source file currently names an MCP config, MCP server, or MCP credential path.
- Claude, Codex, and opencode are launched with `...process.env`; therefore their
  CLIs can implicitly discover host config, credentials, plugins, MCP servers, and
  sessions through the inherited home/profile environment even though NoCLI.ai does not
  call those paths directly.
- The only explicit agent-home read found is `src/commands.js:12`,
  `path.join(os.homedir(), '.claude', 'commands')`. There are no explicit
  `~/.codex` or `~/.opencode` reads in this repository.
- `src/main.js:570` hardcodes `ANTHROPIC_AUTH_TOKEN: 'ollama'`; this is a routing
  sentinel, not a user credential, but it still couples the Claude adapter to
  Ollama's Anthropic endpoint.

## Required NoCLI.ai isolation contract

1. `NOCLI_HOME` is the sole application root for runtime state. Resolve it once at
   startup (platform-appropriate default if unset), create it with restrictive
   permissions, and pass the absolute value to every Terminal child.
2. `NOCLI_HOME/NOCLI.md` is the canonical NoCLI.ai identity, operating policy, and
   workspace guidance. Terminal loads it explicitly; Electron may append a
   project instruction, but must not silently merge Claude/Codex/opencode prompts.
3. Keep separate, namespaced stores under `NOCLI_HOME`: `mcp/config.json`,
   `credentials/` (OS keychain references or encrypted blobs), and `sessions/`.
   A provider adapter may receive a scoped credential handle, never the whole
   credential directory.
4. No implicit reads of `~/.codex`, `~/.claude`, `~/.opencode`, or any other host
   agent directory. In particular, do not inherit host HOME/USERPROFILE for
   Terminal children unless the child receives an equivalent isolated home.
5. MCP servers must be allowlisted by NoCLI.ai/Terminal config, launched with the
   same sanitized environment, and reported as capabilities. Do not auto-import
   host MCP registrations or credentials.
6. Workspace files remain separately scoped from `NOCLI_HOME`; a request carries
   an explicit absolute `cwd`/workspace ID, and sessions cannot silently switch
   workspaces on resume.

## Suggested Electron ↔ Terminal event contract

Keep the renderer-facing event names during the first migration, but make the
payloads envelope-shaped and provider-neutral:

```text
request:  { type: "turn.start", requestId, sessionId?, workspaceId, cwd,
            prompt, systemPrompt?, model?, provider?, images?, policy?, grants? }

events:   { type: "turn.started", requestId, sessionId }
          { type: "assistant.delta", requestId, text }
          { type: "step", requestId,
            step: { type: "thinking"|"tool_call"|"tool_result",
                    id?, fn?, args?, result?, is_error? } }
          { type: "turn.error", requestId, message, code? }
          { type: "turn.done", requestId, sessionId, ok, steered? }
```

This is a direct generalization of the existing `chat-delta`, `chat-step`,
`chat-error`, and `chat-done` sends in `src/main.js:604-629,655-674,714-731`
and the normalized flows in `src/cc.js`/`src/oc.js`. It preserves ordering,
request correlation, resumable sessions, and tool-step rendering while allowing
Terminal to replace Claude/Codex/opencode parsers behind one boundary. Add
`capabilities`, `permission.requested`, and `mcp.status` as separate event types;
do not overload assistant text or tool results with authorization state.

## Migration order

1. **P0 — establish isolation and protocol.** Implement `NOCLI_HOME`, `NOCLI.md`,
   namespaced MCP/credentials/sessions, sanitized child env, and the event/request
   contract. Add fixtures using a temporary home.
2. **P0 — introduce the Terminal adapter.** Replace `runChat`/`runCodex`/
   `runOpencode` dispatch with one Terminal client while keeping the existing
   renderer event names through a compatibility translator. Preserve session IDs,
   stop, steer, image, cwd, and policy behavior.
3. **P0 — move command and prompt ownership.** Port `COMMAND_DIRS` and
   `nocliSystemPrompt` to Terminal/`NOCLI.md`; explicitly migrate user commands once
   and remove all `~/.claude` access.
4. **P1 — move persistence and discovery.** Migrate `settings.json`, command
   catalog, dependency status, and session metadata into NoCLI.ai-owned stores/APIs;
   remove sibling predecessor merges and throwaway Claude discovery calls.
5. **P1 — rework UI and installers.** Rename `window.nocli`, labels, dependency
   installer, model catalogue, and README around Terminal/provider capabilities.
6. **P1/P2 — adapt LAN and optional runtimes.** Forward the new envelopes over
   LAN; re-home Ollama, Exo, llama.cpp, Codex, and opencode as explicit adapters.
   Delete direct CLI/provider launch paths only after real multi-turn, resume,
   permission, stop/steer, image, and LAN tests pass.
