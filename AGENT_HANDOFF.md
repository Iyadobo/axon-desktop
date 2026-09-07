# Axon Agent Handoff

## Product shape

Axon is **one interface**. A single conversation list, a single active chat, and
one **scope** control that says what the current turn may touch:

| Scope | Means | Resolves to |
| --- | --- | --- |
| `chat` | Direct conversation, no tools | `productMode: chat`, streamed direct |
| `read` | Reads files, browses, never writes | `productMode: code`, permission `approve` |
| `edit` | Edits files, runs ordinary commands | `productMode: code`, permission `auto` |
| `full` | Withholds nothing, may delegate | `productMode: agent`, permission `full` |

The retired Chat/Code/Work surfaces only ever encoded two booleans (workspace
tools on/off, delegation on/off) but cost a three-way split of the shell, the
recents list, and the active-conversation slot. **Do not reintroduce them.**
Scope can change mid-conversation without forking the context.

`productMode` and `permissionMode` still exist as *derived* values so
`capabilities.js`, the native loop, and the engines keep their contract — but
scope is the only thing a user sets. `src/engines.js` owns that mapping.

Preserve the Axon dark/pink desktop identity and the top-right Browser and
Agents controls.

## Engines

The agent harness is a swappable adapter, not a fork. `src/engines.js` is the
registry; `provider.kind` is the model route and `provider.engine` is the
harness. These are separate axes — collapsing them into one field is what
produced combinations that failed at inference time.

| Engine | Binary | Valid routes |
| --- | --- | --- |
| `qwen` (default) | `qwen` | Ollama, OpenAI-compatible |
| `claude` | `claude` | Ollama (Anthropic-shaped `/v1/messages`) |
| `codex` | `codex` | Ollama, Responses-compatible |
| `none` | — | Ollama (Axon's own function-call loop) |

`engineSupportsProvider` / `engineRefusal` refuse an invalid pair **before
spawn**, with a sentence the user can act on. Add a rule there rather than
writing another one-off guard at a call site.

**Adding a spawn-and-stream engine** is two entries: one in `ENGINE_RUNNERS`
(`src/main.js`) and one in `STREAM_JSON_ENGINES`. Claude Code and Qwen Code emit
the *same* stream-json schema (`system/init`, `assistant` with
text/thinking/tool_use parts, `user` carrying `tool_result`, final `result`), so
`runStreamJsonCli` parses both and only argv differs. Codex uses its own schema
and keeps `runOfficialCodex`.

Known-bad pair kept as a guard: Ollama Cloud rejects Codex's freeform tool
schema before inference. See `engineModelRefusal`.

## Files to change

- `src/engines.js`: scope table, engine registry, route/engine compatibility, provider migration.
- `src/main.js`: Electron lifecycle, engine dispatch, Browser view, Cloud events, zoom.
- `src/ollama-cloud-agent.js`: the `none` engine — Ollama function-call loop, delegation, subagents. Works for local and `:cloud` models.
- `src/renderer/app.js`: scope control, engine picker, single conversation list, persistence.
- `src/renderer/index.html`: renderer layout and CSS.
- `src/capabilities.js`: honest capability language; never let models claim unimplemented abilities or another product identity.
- `src/axon-browser-mcp.js`: Browser MCP bridge.

## Persistence

Saved conversation `turns` are passed back into the native loop for every
workspace turn. This is the restart/update recovery path; do not remove it.

Settings migrate on load: an older `productMode` + `permissionMode` pair
recovers its nearest scope (`scopeFromLegacy`), and a saved provider carrying
the retired `codex-cli` / `claude-cli` kind splits into route + engine
(`migrateProvider`). Both are covered by `npm run check`.

Subagent status flows: native loop → `subagent-update` in `main.js` → Agents
panel in `app.js`.

## Fast workflow

Use source Preview for iterative work, not an installer every change:

`node_modules\electron\dist\electron.exe . --user-data-dir=C:\Users\Iyad\AppData\Local\Temp\axon-preview`

Restart Preview after source edits. Package only at a tested checkpoint with `npm run dist:win`.

## Git state

Remote is `origin` = `Iyadobo/axon-desktop`. Work happens on feature branches;
`main` is only moved deliberately.

As of 2026-09-07 the current line is `claude/one-interface-engine-registry` at
`29de7a1`, pushed and tracking `origin/claude/one-interface-engine-registry`. It
is 20 commits ahead of `main` (`50ffb34`) and has **not** been merged; no PR is
open. `codex/model-picker-hover-fix` is 16 commits ahead of its upstream and
unpushed, and `experimental` (`bfe7161`) is a deliberately local-only WIP
snapshot — leave both alone unless asked.

Push a branch as soon as it holds work worth keeping: this branch carried 20
commits with no upstream at all, so a machine loss would have taken all of them.

## Storage and safety

`axon-terminal/` is a **retired** Rust fork, ~7.4 GB, untracked and no longer
referenced by any code path (`findAxonTerminal` was removed). It is kept only
because it is user-owned; deleting it is the user's call. Do not stage
user-owned untracked terminal/assets/preview files.

Also untracked and deliberately unstaged: `worker-viewmodel-1840/` and
`minecraft-rotten-flesh-leather/` (unrelated asset projects), `_to_delete/`
(stale git index locks only), and the three
`src/assets/axon-neural-paintbrush-v*.png` candidates — no code path
references them.

`src/main.js` still writes an `axon-terminal.cmd` CLI shim in `cliDirectory()`.
That shim points at a binary this build no longer ships — clean it up when the
CLI entry points are next revisited.

## Required checks

Run `node --check src/main.js`, `node --check src/engines.js`, `node --check
src/renderer/app.js`, `npm run check` (25 Axon checks + 11 llama.cpp), and `git
diff --check`. For engine changes, run a real turn through the affected engine.
For UI changes, inspect the Preview window.
