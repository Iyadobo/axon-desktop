# Axon

> An experimental local-first agent workspace. It is usable, but still being
> actively shaped—issues and small pull requests are welcome.

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
npm run check      # parser, command, config, and Ollama reachability checks
npm run dist:win   # build a Windows installer
```

## License

[MIT](LICENSE). Axon is published quietly and without a formal support promise;
use it, learn from it, and improve it if it helps.

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
| `src/llamacpp-bridge.js` | pure Anthropic Messages ⇄ OpenAI chat-completions translator + the loopback bridge server (self-checkable) |
| `src/llamacpp-runtime.js` | installs/spawns the llama.cpp CUDA runtime for the two-PC RPC pool (self-checkable) |
| `src/assets/icon.png` | generated 16×16 tray icon |

## Two-PC llama.cpp RPC runtime (experimental)

Settings → **Inference runtime** has a third option besides Local Ollama and Exo:
**llama.cpp RPC (2-PC VRAM pool)**. It pools the VRAM of two Windows PCs over a
direct, isolated Ethernet link using [llama.cpp's built-in RPC
backend](https://github.com/ggml-org/llama.cpp) — one PC (**Host**) loads a GGUF
model and runs `llama-server --rpc <peer>`; the other (**Worker**) runs
`ggml-rpc-server`, exposing its GPU over the wire. Weights and KV cache are split
across both GPUs' free memory automatically.

**Ollama and Exo both speak the Anthropic Messages API natively, so Claude Code's
`ANTHROPIC_BASE_URL` can point straight at them. llama.cpp only speaks
OpenAI-style `/v1/chat/completions`, so this adapter is not a thin passthrough —
`src/llamacpp-bridge.js` is a real, loopback-only translation layer** (Anthropic
streaming events ⇄ OpenAI SSE chunks, including tool-call ⇄ `tool_calls`
mapping) that Claude Code talks to instead.

**What Axon does for you, on this PC:**
- Downloads and installs the official prebuilt llama.cpp Windows CUDA release
  (`ggml-org/llama.cpp` release `b10549`, ~640 MB: the CUDA build itself plus its
  `cudart` DLLs) into `runtimes/llamacpp/bin` — no cmake/nvcc/ninja needed. This
  only happens when you click **Install llama.cpp CUDA runtime**; nothing
  downloads on its own.
- Lets you pick a **local `.gguf` file** via a real file picker. Axon never
  downloads a model for you — GGUF choice and placement is yours.
- Spawns `llama-server` (Host) or `ggml-rpc-server` (Worker) and runs the
  Anthropic⇄OpenAI bridge on loopback (`127.0.0.1:47420`) so Claude Code can talk
  to it exactly like it talks to Ollama.

**What you must do on the *other* PC — Axon cannot reach across the isolated
link to configure it:**
1. Give it a static IP on the same isolated NIC, e.g. `192.168.50.2/24`
   (adjust to match whatever the Host PC actually uses).
2. Install Axon there too (same build), open Settings → Inference runtime →
   llama.cpp RPC → click **Install llama.cpp CUDA runtime**.
3. Set role to **Worker**, pick its own IP as the bind address, **Start**.
4. Back on the Host PC, set the RPC peer field to `<worker-ip>:50052` and use
   **Test peer** to confirm the link before **Start**.

**Network note:** a gigabit-capable NIC can still negotiate down to 100 Mbps
on a short direct-connect link. On this dev machine that turned out to be
Realtek's **Energy-Efficient Ethernet / Green Ethernet** power-saving features
(`Get-NetAdapterAdvancedProperty` on the adapter) rather than a bad cable or a
forced speed — worth checking on both PCs before assuming the cable is at
fault. 100 Mbps still works end-to-end; it is just a much slower proof-only
path for the sizes of tensor traffic RPC moves per token.

**Security:** llama.cpp's own RPC docs call it experimental and unauthenticated
— no auth, no transport encryption. Axon's Worker bind is checked in code
against this machine's *own* interface addresses (never `0.0.0.0`, never an
address you don't actually own), but nothing stops another device on that same
subnet from talking to it. Only ever run this over a direct, physically
isolated Ethernet cable between the two PCs — never on a shared/routable
network.

**Verified so far (this PC, RTX 5060 Laptop 8 GB, no second PC in this
environment):** the installer downloads and extracts real binaries that run;
`ggml-rpc-server` binds the real isolated-NIC address (`192.168.50.1:50052`),
detects the GPU, and accepts a real TCP connection; the bind-guard rejects
addresses this machine doesn't own; the Anthropic⇄OpenAI bridge is verified
end-to-end over real loopback sockets (`npm run check`) including tool-call
argument reassembly. **Not verified:** an actual two-PC RPC inference run (no
second machine here) and a real chat turn through `llama-server` (no GGUF
chosen — pick one in Settings and click Start to complete that last step
yourself). Tool-calling fidelity through llama.cpp also depends on the GGUF's
own chat template support for tool/function calling, unlike Ollama where Axon
already knows this works.

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

## Third-party marks

The model picker shows each family's own logo. Those marks are vendored into
`src/renderer/model-logos.js` from [simple-icons](https://github.com/simple-icons/simple-icons),
whose icon data is CC0. Regenerate with:

```
npm i --no-save simple-icons && node scripts/gen-model-logos.js
```

The marks remain the trademarks of their respective owners. Axon uses them
nominatively — to identify which model family a row refers to — which implies no
affiliation with or endorsement by those companies.

simple-icons deliberately does not carry Microsoft, IBM or OpenAI marks, so the
Phi, Granite and GPT families keep Axon's own neutral glyphs instead. Those marks
are not sourced from anywhere else, and that is on purpose: please don't swap in
an imitation.
