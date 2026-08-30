# Axon Product Shell Design QA

- Source visual truth: `C:\Users\Iyad\AppData\Local\Temp\codex-clipboard-d9a5de77-a253-4a4b-ac9a-eabcb2a01bac.png`
- Implementation: Electron Preview from `src/renderer/index.html`
- Final native implementation capture: `C:\Users\Iyad\AppData\Local\Temp\axon-product-pass-2026-08-30\12-chat-final-native.png`
- Density-normalized implementation: `C:\Users\Iyad\AppData\Local\Temp\axon-product-pass-2026-08-30\13-chat-final-normalized.png`
- Combined comparison: `C:\Users\Iyad\AppData\Local\Temp\axon-product-pass-2026-08-30\14-source-final-comparison.png`
- Viewport and density: source 1919 × 997 px; native implementation 1683 × 859 CSS px at device scale factor 1. The native capture was proportionally scaled to 1919 px wide and centered on a 1919 × 997 canvas so the comparison preserves the implementation aspect ratio without cropping or stretching.
- State: midnight theme, Chat workspace, empty conversation, no modal or utility drawer open.

## Full-view comparison evidence

The combined comparison shows the same dark Axon shell and empty Chat composition. The implementation intentionally changes the requested product chrome: Settings is removed from the title navigation and placed under a non-editable Local workspace identity; Agents becomes an icon-only Subagents control; Browser becomes an icon-only browser control; the Chat dendrite uses its source orientation instead of the previous mirrored transform. The primary composer and mode hierarchy remain visually stable.

## Focused-region evidence

- Swarm default state: `C:\Users\Iyad\AppData\Local\Temp\axon-product-pass-2026-08-30\02-swarm-defaults.png`
- Provider hub, default Ollama state: `C:\Users\Iyad\AppData\Local\Temp\axon-product-pass-2026-08-30\07-settings-provider-first.png`
- Add API expanded state: `C:\Users\Iyad\AppData\Local\Temp\axon-product-pass-2026-08-30\05-add-api-open.png`
- Compact shell: `C:\Users\Iyad\AppData\Local\Temp\axon-product-pass-2026-08-30\06-compact-shell.png`

Focused evidence was required because the source screenshot did not show the new provider and Swarm interaction states.

## Required fidelity surfaces

- Fonts and typography: Existing Axon display/body families, optical weights, type scale, and restrained small chrome are preserved. No new competing type treatment was introduced.
- Spacing and layout rhythm: Title chrome is materially quieter, the footer is grouped as local workspace plus Settings, Swarm defaults read in one horizontal sequence, and compact mode retains 44 px utility targets without horizontal overflow.
- Colors and visual tokens: Existing background, surface, rule, text, muted, and pink signal tokens are reused. Pink continues to indicate selection and primary action rather than decoration.
- Image quality and asset fidelity: Existing Axon raster marks are reused at native UI scale. The Chat dendrite is no longer mirrored. No generated raster was needed because the requested additions are standard controls and existing product marks already cover the product-specific roles.
- Copy and content: Profile/account language is removed. Swarm explains one outcome, three workers, and one synthesized answer. Provider copy clearly separates local Ollama from API setup.

## Interaction and accessibility checks

- Add API opens the connection form; Use Ollama restores `ollama-local`, closes API details, and leaves saved API connections intact.
- Subagents and Browser controls open their respective panels and update `aria-expanded`.
- Settings is keyboard-named in compact mode.
- Final Preview reload produced no console errors or warnings.
- Measured minimum visible action height is 44 px; horizontal overflow is 0 px at the measured desktop and 390 px compact widths.

## Comparison history

1. P2: The first settings capture placed provider controls below instructions, permissions, and workspace mode, forcing a scroll for the requested primary task. Fix: visually promoted Model provider to the first Settings section. Post-fix evidence: `07-settings-provider-first.png`.
2. P2: The original Swarm surface exposed Sentry model, worker model, and worker count before the user could state an outcome. Fix: replaced it with one-action defaults and moved tuning into an optional disclosure. Post-fix evidence: `02-swarm-defaults.png`.
3. P2: Compact Browser remained wider than its icon-only purpose. Fix: constrained both utility icons to 44 px. Post-fix evidence: `06-compact-shell.png`.

## Findings

No actionable P0, P1, or P2 findings remain in the requested shell, Swarm, provider, and compact states.

## Follow-up polish

- P3: A future pass could add a live count badge to Subagents once the backend exposes a stable active-task count; showing a permanent zero now would add noise.

final result: passed
