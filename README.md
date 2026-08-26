# Axon

Axon is a local-first workspace with three deliberately separate ways to work:

- **Axon Chat** — direct streamed conversation with Ollama or a configured API profile.
- **Axon Code** — project work through the bundled **Axon Terminal**.
- **Axon Agent** — Axon Terminal with scoped native subagents enabled.

It does not require Claude Code, Codex CLI, or OpenCode to be installed.

## What is included

- Local Ollama, Exo, and llama.cpp RPC inference runtimes.
- Separate provider profiles, system prompts, model choices, and encrypted API-key storage.
- An isolated Axon Terminal home (`AXON_HOME`), independent of Codex configuration.
- A native browser sidebar that opens automatically when an agent invokes the Axon Browser MCP.
  Browser reading is text-first; screenshots are withheld from text-only models.
- Native desktop window controls, projects, recents, themes, model downloads, tray behavior, and LAN workspace sharing.

## Run from source

```powershell
npm install
npm start
npm run check
```

For Code and Agent modes, build the terminal fork first:

```powershell
Set-Location axon-terminal\codex-rs
& "$env:USERPROFILE\.cargo\bin\cargo.exe" build --release -p codex-cli --bin axon
Set-Location ..\..
npm run dist:win
```

`dist:win` bundles the release `axon.exe` plus the Axon Browser MCP script in the Windows installer.

### Debian / Linux

On Debian or Ubuntu, install the standard Electron build prerequisites, build the
native Axon Terminal binary, then produce a Debian package:

```bash
sudo apt update
sudo apt install -y build-essential libgtk-3-dev libnss3-dev libasound2-dev libxss1 libxtst6 libnotify-dev libatspi2.0-dev libdrm-dev libgbm-dev
cd axon-terminal/codex-rs
cargo build --release -p codex-cli --bin axon
cd ../..
npm ci
npm run dist:deb
```

The package is written to `dist/Axon_<version>_amd64.deb`. The packaging hook copies
the Linux `axon` binary into the app resources and fails clearly if it has not been
built, so Code and Work cannot ship as empty shells. `npm run dist:linux` still emits
both the `.deb` and AppImage variants.

Linux updates use the separate `Iyadobo/Axon-Debian` release feed by default, while
Windows continues to use `Iyadobo/Axon`. Axon checks the appropriate feed shortly
after startup and then in the background every six hours. To publish a verified
Debian release after building it, run `npm run publish:deb -- -Version <version>`
with `AXON_DEB_RELEASE_REPOSITORY` set to the target GitHub repository.

## Runtime design

```text
Axon Chat    → selected Ollama/API provider
Axon Code    → Axon Terminal → workspace + Axon Browser MCP
Axon Agent   → Axon Terminal → workspace + native subagents + Axon Browser MCP
```

The browser bridge is loopback-only, uses a fresh per-launch bearer token, and accepts only bounded POST requests. Its MCP gives agents `browser_open`, `browser_read`, `browser_click`, `browser_type`, and a guarded `browser_screenshot` tool. A read returns page text and stable control IDs; a model has to be identified as vision-capable before screenshots are enabled.

## Commands

The composer has a small set of Axon-owned commands:

- `/new` or `/clear` — fresh conversation
- `/model <name>` — select a known model by prefix
- `/help` — show commands and modes
- `/compact` — start a fresh context

## Files worth knowing

| Path | Purpose |
| --- | --- |
| `src/main.js` | Electron main process, providers, native modes, browser bridge |
| `src/axon-browser-mcp.js` | stdio MCP adapter for the native browser |
| `src/renderer/` | desktop UI, themes, projects, settings |
| `axon-terminal/` | Axon Terminal fork; provenance is preserved in `PROVENANCE.md` |
| `src/selfcheck.js` | browser/config/runtime checks |

## Safety notes

Code and Agent use Axon Terminal sandbox levels: **Approve** maps to read-only, **Auto** to workspace write, and **Full** to unrestricted local work. Full mode is powerful; use it only in a workspace you intend the agent to change.

The optional llama.cpp RPC worker is an experimental, unauthenticated direct-LAN transport. Use it only on a physically isolated link between machines; never expose it on a shared or routable network.

## License

The desktop app is [MIT](LICENSE). Axon Terminal is a tailored fork with its upstream Apache-2.0 provenance and notices kept in its own directory.
