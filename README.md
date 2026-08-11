# Axon

Axon is a local agent workspace where **the chat is powered by the Claude Code
agent harness**, routed to your selected Ollama model, with **Claude Code slash commands** usable
from the chat input.

The official Ollama desktop app (`ollama/ollama` → `app/`) is a thin native shell that owns the
`ollama serve` subprocess lifecycle. `ollama launch claude` launches Claude Code pointed at an
Ollama model. This project recreates the desktop shell in **Node + Electron** and makes that
`launch claude` pattern the chat itself: each turn runs Claude Code headless (`claude -p
--output-format stream-json`) routed to the selected Ollama model via Ollama's native
Anthropic-compatible `/v1/messages` endpoint. Visual style is a recreation of the "Relay" modernist
mockup (light theme, 240px sidebar with Recents, centered empty-state, surface composer card).

## What it does

- **Sidebar + Recents** — brand, "New chat", a Recents list (persisted in `localStorage`),
  backend + status dot in the footer. Click a recent to resume that Claude Code session.
- **Tray + window** — status reflects `ollama serve`; close → hide-to-tray; tray click reopens.
- **`ollama serve` lifecycle** — reuses a running daemon, else spawns and supervises one.
- **Claude Code harness** — every turn runs `claude -p` headless with `--output-format stream-json`,
  pointed at the selected Ollama model (`ANTHROPIC_BASE_URL=http://127.0.0.1:11434`,
  `--model <your model>`). Claude Code's agent loop does the work (Read/Write/Edit/Bash/Glob/Grep/WebFetch).
- **Tools auto-run** — scoped via `--allowedTools` (not blanket `--dangerously-skip-permissions`).
- **Multi-turn / multi-conversation** — each conversation keeps its Claude Code `session_id`; the
  app `--resume`s it across turns. "New chat" starts a fresh session.
- **Inline tool steps** — tool calls + results render as compact `▸ Tool {…}` / `↳ result` lines
  above the reply.
- **Slash commands** (see below).

## Slash commands

Claude Code's slash commands are an **interactive-REPL** feature. In headless `claude -p` mode they
do **not** run: passing `/clear` or `/model` as a prompt just sends that literal string to the model
(verified). So the app handles them itself:

- **Built-in REPL commands** — intercepted in the renderer:
  - `/new` · `/clear` — start a fresh chat
  - `/model <name>` — switch model (prefix match)
  - `/help` — list available commands (including your custom ones, with descriptions)
  - `/compact` — unavailable in headless mode (tells you to use `/clear`)
- **Custom commands** — `~/.claude/commands/*.md` (and `<cwd>/.claude/commands/*.md`) are expanded
  **by the app** (`src/commands.js`) and sent as the prompt. `$ARGUMENTS` and `$1..$N` are
  substituted, YAML frontmatter is stripped. This was verified end-to-end: a command injecting a
  secret word produced that word from the model through the full chain.
  - `ponytail:` only `$ARGUMENTS`/`$1..$N` + frontmatter are supported. `$FILE`, `$WORKDIR`, and
    `` !`shell` `` includes are not — add them when a command needs them.
- **Anything else** `/foo` — passed through to the model verbatim (so an unknown `/foo` is just a
  prompt; the model responds).

## Run

```
npm install
npm start          # launch the app
npm run check      # 19 self-checks: stream-json parser + command expansion/discovery + Ollama ping
```

## How it routes

```
renderer ─IPC─▶ main ─expand /cmd─▶ claude -p --model <ollama-model> --output-format stream-json --verbose
                  │                    │ env: ANTHROPIC_BASE_URL=http://127.0.0.1:11434
                  │ custom /cmd         ▼
                  │ expanded here   Ollama native /v1/messages  ─▶  your selected model
                  │ (Claude Code does NOT expand them in -p mode)
```
Claude Code emits stream-json lines; `src/cc.js` parses them into deltas (assistant text) and steps
(tool calls/results) that the renderer shows inline. `src/commands.js` expands custom slash commands
before the prompt reaches `claude`.

## Files

| path | role |
|------|------|
| `src/main.js` | Electron main: tray, window, `ollama serve` lifecycle, spawns Claude Code per turn, IPC |
| `src/cc.js` | pure parser: Claude Code stream-json line → normalized event (self-checkable) |
| `src/commands.js` | pure slash-command expansion + discovery (self-checkable, no Electron dep) |
| `src/preload.js` | contextBridge IPC surface |
| `src/renderer/{index.html,app.js}` | Relay-styled chat UI: sidebar, Recents, home/chat, slash commands |
| `src/selfcheck.js` | assertions over the parser + command expansion + an Ollama reachability ping |
| `src/assets/icon.png` | generated 16×16 tray icon |

## Notes / trade-offs (`ponytail:`)

- **Model quality matters a lot.** Claude Code ships a heavy system prompt; small models
  (`qwen2.5:1.5b`, `tinyllama`) ramble or ignore instructions. `qwen2.5:1.5b` could not follow even a
  trivial "reply with one word" command through the harness. Use `qwen3-coder`, `qwen3:4b`,
  `llama3.1:8b`, or a cloud model for real work. The harness is only as good as the model driving it.
- `--verbose` is required for `stream-json`; it emits many `system`/hook events. The parser ignores
  `system` events, so they never reach the UI.
- `claude.exe` is spawned by full path (`where claude`) with `shell:false`, so arbitrary prompts
  (with `&`, `|`, `>`, quotes) are passed literally — no shell injection.
- `ollama serve` is killed on quit only if this app spawned it; an external daemon is left alone.
- **Recents resume agent context, not visible history.** Clicking a recent resumes the Claude Code
  session (the agent remembers), but prior messages are not re-rendered (fetching transcripts is out
  of scope). A system note says so.
- **Custom command expansion is app-side by necessity** — Claude Code does not expand
  `~/.claude/commands/*.md` in headless `-p` mode (verified). Built-in REPL commands can't run
  headless at all, so the few useful ones are reimplemented app-side.
