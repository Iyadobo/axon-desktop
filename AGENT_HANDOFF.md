# Axon Agent Handoff

## Product shape

Axon has three separated modes: Chat (direct conversation), Code (repository work), and Work (multi-step tasks with browser/delegation). Preserve the Axon dark/pink desktop identity and the top-right Browser and Agents controls.

## Routing

`src/main.js` owns execution routing.

- Local and Responses-compatible Code/Work use Axon Terminal via `runAxonTerminal`.
- Ollama `:cloud` Code/Work use `src/ollama-cloud-agent.js`. Do not send Cloud models through Axon Terminal: its Codex freeform tool schema is rejected by Ollama Cloud.
- The native Cloud loop exposes `run_command`, `browser_open`, `browser_read`, plus Work-only `delegate_task`.
- `delegate_task` inherits the selected parent model by default; optional `model` overrides it. Recursive delegation is deliberately disabled.

## Files to change

- `src/main.js`: Electron lifecycle, provider routing, Browser view, terminal launch, Cloud events, zoom.
- `src/ollama-cloud-agent.js`: Cloud tool schema, agent loop, delegation and subagent lifecycle.
- `src/renderer/app.js`: mode-specific active chats, persistence, Browser/Agents panel behavior.
- `src/renderer/index.html`: renderer layout and CSS.
- `src/capabilities.js`: honest system capability language; never let models claim unimplemented abilities or another product identity.
- `src/axon-browser-mcp.js`: Axon Terminal Browser MCP bridge.

## Persistence

Saved conversation `turns` are passed back into the Cloud loop for every Code/Work request. This is the restart/update recovery path; do not remove it. `settings.activeConversationIds` keeps separate Chat, Code, and Work active conversations.

Subagent status flows: native loop → `subagent-update` in `main.js` → Agents panel in `app.js`. The panel shows status/model/task/result; it is not an interactive supervisor console yet.

## Fast workflow

Use source Preview for iterative work, not an installer every change:

`node_modules\electron\dist\electron.exe . --user-data-dir=C:\Users\Iyad\AppData\Local\Temp\axon-preview`

Restart Preview after source edits. Package only at a tested checkpoint with `npm run dist:win`.

## Storage and safety

`axon-terminal/` is a separately managed, untracked fork. Preserve its `.git` history and user changes. Its Rust release cache is about 15 GB; do not cold-build it casually. Do not stage user-owned untracked terminal/assets/preview files.

## Required checks

Run `node --check src/main.js`, `node --check src/ollama-cloud-agent.js`, `node --check src/renderer/app.js`, `npm run check`, and `git diff --check`. For Cloud changes, run a real Cloud smoke test. For UI changes, inspect the Preview window.
