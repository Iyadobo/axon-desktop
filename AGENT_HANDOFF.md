# NoCLI.ai Agent Handoff

## Product shape

NoCLI.ai is **one interface**. A single conversation list, a single active chat, and
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

Preserve the NoCLI.ai black/white/red desktop identity and the top-right Browser and
Agents controls. The app icon is the red prohibited symbol over white `CLI`.

## Engines

The agent harness is a swappable adapter, not a fork. `src/engines.js` is the
registry; `provider.kind` is the model route and `provider.engine` is the
harness. These are separate axes — collapsing them into one field is what
produced combinations that failed at inference time.

| Engine | Binary | Valid routes |
| --- | --- | --- |
| `kimi` (default) | `kimi` | Ollama, OpenAI-compatible |
| `qwen` | `qwen` | Ollama, OpenAI-compatible |
| `claude` | `claude` | Ollama (Anthropic-shaped `/v1/messages`) |
| `codex` | `codex` | Ollama, Responses-compatible |
| `none` | — | Ollama (NoCLI.ai's own function-call loop) |

`engineSupportsProvider` / `engineRefusal` refuse an invalid pair **before
spawn**, with a sentence the user can act on. Add a rule there rather than
writing another one-off guard at a call site.

**Adding a spawn-and-stream engine** is two entries: one in `ENGINE_RUNNERS`
(`src/main.js`) and one in `STREAM_JSON_ENGINES`. Claude Code and Qwen Code emit
the *same* stream-json schema (`system/init`, `assistant` with
text/thinking/tool_use parts, `user` carrying `tool_result`, final `result`), so
`runStreamJsonCli` parses both and only argv differs. Kimi Code uses OpenAI-shaped
assistant/tool JSONL plus meta records for version and session resume; its
adapter supplies the selected route through process-local `KIMI_MODEL_*`
variables and never rewrites Kimi's config. Codex uses its own schema and keeps
`runOfficialCodex`.

Kimi Code print mode always runs with its own automatic permission policy, so
NoCLI.ai refuses Kimi for the `read` scope rather than claiming a read-only boundary
that the CLI cannot enforce. It remains the default for `edit` and `full`.

Known-bad pair kept as a guard: Ollama Cloud rejects Codex's freeform tool
schema before inference. See `engineModelRefusal`.

## Files to change

- `src/engines.js`: scope table, engine registry, route/engine compatibility, provider migration.
- `src/main.js`: Electron lifecycle, engine dispatch, Browser view, Cloud events, zoom.
- `src/ollama-cloud-agent.js`: the `none` engine — Ollama function-call loop, delegation, subagents. Works for local and `:cloud` models.
- `src/renderer/app.js`: scope control, engine picker, single conversation list, persistence.
- `src/renderer/index.html`: renderer layout and CSS.
- `src/capabilities.js`: honest capability language; never let models claim unimplemented abilities or another product identity.
- `src/nocli-browser-mcp.js`: Browser MCP bridge.

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

`node_modules\electron\dist\electron.exe . --user-data-dir=C:\Users\Iyad\AppData\Local\Temp\nocli-preview`

Restart Preview after source edits. Package only at a tested checkpoint with `npm run dist:win`.

## Git state

Remote is `origin` = `Iyadobo/nocli.ai`. Work happens on feature branches;
`main` is only moved deliberately.

As of 2026-09-10 the current line is `claude/one-interface-engine-registry`,
pushed and tracking `origin/claude/one-interface-engine-registry`. The
one-interface + engine-registry work is commit `29de7a1`; the branch sits 20
commits ahead of `main` (`50ffb34`) before the later handoff/default-engine
updates and has **not** been merged, and no PR is
open. `codex/model-picker-hover-fix` is 16 commits ahead of its upstream and
unpushed, and `experimental` (`bfe7161`) is a deliberately local-only WIP
snapshot — leave both alone unless asked.

Push a branch as soon as it holds work worth keeping: this branch carried 20
commits with no upstream at all, so a machine loss would have taken all of them.

## Storage and safety

NoCLI-owned state is under `%APPDATA%\\NoCLI.ai\\NoCLI Home`: `settings.json`,
its backup, encrypted `provider-secrets.json`, and a non-secret per-engine
`harnesses/<engine>/current-turn.json`. The first launch copies existing NoCLI
state into that home. `src/nocli-home.js` owns this migration and turn context.
The product does **not** clone or overwrite Codex, Claude, Kimi, Qwen, or
OpenCode sign-ins; OpenCode Go/Zen remains authenticated by OpenCode itself.

`nocli-terminal/` is a **retired** Rust fork, ~7.4 GB, untracked and no longer
referenced by any code path (`findNocliTerminal` was removed). It is kept only
because it is user-owned; deleting it is the user's call. Do not stage
user-owned untracked terminal/assets/preview files.

Also untracked and deliberately unstaged: `worker-viewmodel-1840/` and
`minecraft-rotten-flesh-leather/` (unrelated asset projects), `_to_delete/`
(stale git index locks only), and the three
`src/assets/nocli-neural-paintbrush-v*.png` candidates — no code path
references them.

`src/main.js` still writes an `nocli-terminal.cmd` CLI shim in `cliDirectory()`.
That shim points at a binary this build no longer ships — clean it up when the
CLI entry points are next revisited.

## Required checks

Run `node --check src/main.js`, `node --check src/engines.js`, `node --check
src/renderer/app.js`, `npm run check` (25 NoCLI.ai checks + 11 llama.cpp), and `git
diff --check`. For engine changes, run a real turn through the affected engine.
For UI changes, inspect the Preview window.

Kimi Code `0.42.0` was installed from the official npm package on Windows and a
real `kimi-k3:cloud` turn through Ollama's OpenAI-compatible route returned
`KIMI_NOCLI_OK`, including a resumable session id in the JSONL stream.

## 2026-09-10 NoCLI identity handoff

- Product and release repositories are `Iyadobo/nocli.ai`,
  `Iyadobo/nocli.ai-releases`, and `Iyadobo/nocli.ai-debian`. `Iyadobo/Axon`
  is deliberately retained as the legacy Windows update bridge: existing Axon
  builds cannot follow GitHub repository-rename redirects. The `v0.7.29` Axon
  bridge installer prompts users to switch to the verified NoCLI.ai installer.
- The logo source is `src/assets/nocli-mark.svg`. It is a flat ink tile with
  white `CLI` and a red prohibited circle/slash; regenerate `icon.png` and
  `icon.ico` with `python scripts/generate_nocli_icon.py` after changing it.
- `src/renderer/app.js` defaults and migrates the prior blue/pink palettes to
  the black/white/red midnight palette. Keep custom user palettes intact.
- Recent commits: `d32c6d8` rebrand, `f9cb754` flat mark, `989fb09` prohibited
  mark, `916266c` red icon output, and `98bf832` red vector source. Run
  `npm run check` plus renderer syntax checks after visual changes.
- `v0.7.29` is live: NoCLI.ai has `nocli.ai-Setup-0.7.29.exe` plus SHA-256 in
  `Iyadobo/nocli.ai-releases`; Axon has `Axon-Setup-0.7.29.exe` plus SHA-256
  in `Iyadobo/Axon`. The temporary Axon source bridge is the pushed branch
  `codex/axon-to-nocli-migration` (commit `f2efa44`).
