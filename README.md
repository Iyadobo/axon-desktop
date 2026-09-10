# NoCLI.ai

NoCLI.ai is a local-first desktop workspace that puts models, tools, and official harnesses behind one calm interface. It is for people who want the power without living in a terminal or paying for a mystery “super agent” subscription.

- **Just chat** — direct streamed conversation with a local runtime or a configured API profile.
- **Read** — workspace and browser access without writes.
- **Edit** — project work through the selected agent engine.
- **Full** — multi-step work with delegation available.

Kimi Code is the default agent engine. OpenCode, Qwen Code, Claude Code, Codex CLI, and
NoCLI.ai's native local-runtime loop remains a selectable alternative.

## What is included

- Local runtime support through Ollama, Exo, and llama.cpp RPC.
- Separate provider profiles, system prompts, model choices, and encrypted API-key storage.
- A swappable engine registry kept separate from model-provider routing.
- A native browser sidebar that opens automatically when an agent invokes the NoCLI.ai Browser MCP.
  Browser reading is text-first; screenshots are withheld from text-only models.
- Native desktop window controls, projects, recents, themes, model downloads, tray behavior, and LAN workspace sharing.

## Run from source

```powershell
npm install
npm start
npm run check
```

Build a Windows installer after the source checks pass:

```powershell
npm run dist:win
```

Agent engines are official external CLIs. Install the ones you want available in
the engine picker; Kimi Code can be installed with
`npm install -g @moonshot-ai/kimi-code`, and OpenCode with
`npm install -g opencode-ai`. OpenCode profiles can use an existing Go or Zen
login, or NoCLI.ai's encrypted OpenRouter/OpenAI-compatible API profile.

### Debian / Linux

On Debian or Ubuntu, install the standard Electron build prerequisites, then
produce a Debian package:

```bash
sudo apt update
sudo apt install -y build-essential libgtk-3-dev libnss3-dev libasound2-dev libxss1 libxtst6 libnotify-dev libatspi2.0-dev libdrm-dev libgbm-dev
npm ci
npm run dist:deb
```

The package is written to `dist/nocli.ai_<version>_amd64.deb`.
`npm run dist:linux` emits both the `.deb` and AppImage variants.

Linux updates use the separate `Iyadobo/nocli.ai-debian` release feed by default, while
Windows uses `Iyadobo/nocli.ai-releases`. NoCLI.ai checks the appropriate feed shortly
after startup and then in the background every six hours. To publish a verified
Debian release after building it, run `npm run publish:deb -- -Version <version>`
with `NOCLI_DEB_RELEASE_REPOSITORY` set to the target GitHub repository.

## Runtime design

```text
Just chat    → selected local runtime/API provider directly (OpenCode auth stays in its CLI)
Read/Edit    → selected provider + selected engine → workspace/browser tools
Full         → selected provider + selected engine → workspace/browser/delegation
```

The browser bridge is loopback-only, uses a fresh per-launch bearer token, and accepts only bounded POST requests. Its MCP gives agents `browser_open`, `browser_read`, `browser_click`, `browser_type`, and a guarded `browser_screenshot` tool. A read returns page text and stable control IDs; a model has to be identified as vision-capable before screenshots are enabled.

## Commands

The composer has a small set of NoCLI.ai-owned commands:

- `/new` or `/clear` — fresh conversation
- `/model <name>` — select a known model by prefix
- `/help` — show commands and modes
- `/compact` — start a fresh context

## Files worth knowing

| Path | Purpose |
| --- | --- |
| `src/main.js` | Electron main process, providers, native modes, browser bridge |
| `src/nocli-browser-mcp.js` | stdio MCP adapter for the native browser |
| `src/renderer/` | desktop UI, themes, projects, settings |
| `src/engines.js` | scope definitions, engine registry, compatibility rules |
| `src/selfcheck.js` | browser/config/runtime checks |

## Safety notes

Each official engine enforces permissions through its own supported controls.
Kimi Code's non-interactive mode cannot enforce a read-only workspace, so NoCLI.ai
refuses that engine in **Read** scope. **Full** is powerful; use it only in a
workspace you intend the agent to change.

The optional llama.cpp RPC worker is an experimental, unauthenticated direct-LAN transport. Use it only on a physically isolated link between machines; never expose it on a shared or routable network.

## License

The desktop app is [MIT](LICENSE). External agent engines keep their own licenses
and are installed separately.
