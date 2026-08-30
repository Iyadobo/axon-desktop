# Axon Design visual QA

- Source visual truth: `C:\Users\Iyad\.codex\generated_images\01a04fc8-8669-7731-8d43-6907367d6d1d\exec-457b4fd7-df69-4d56-9aa4-2bd8ce93ba91.png`
- Implementation screenshot: `C:\Users\Iyad\AppData\Local\Temp\axon-design-qa\01-signal-canvas.png`
- Full-view comparison: `C:\Users\Iyad\AppData\Local\Temp\axon-design-qa\04-final-side-by-side.png`
- Focused title-bar comparison: `C:\Users\Iyad\AppData\Local\Temp\axon-design-qa\05-titlebar-side-by-side.png`
- State: Axon Design / Signal Canvas / Focus selected / Overview tab
- Viewport: desktop target, 1440 × 1024 normalized comparison
- Pixels and density: source 1487 × 1058 scaled to 1440 × 1024; implementation captured at 1440 × 1024 through Electron CDP with deviceScaleFactor 1. The renderer reports 1577 × 1122 CSS pixels because the Preview profile applies Electron zoom; the capture and source were normalized to equal pixel dimensions before comparison.

## Findings

No actionable P0, P1, or P2 differences remain.

- [P3] Integrated Axon chrome differs from the standalone concept top bar.
  Location: global title bar.
  Evidence: the concept uses an Axon Design-only breadcrumb bar; the implementation retains Axon's Chat, Projects, Models, and Design product navigation.
  Impact: slightly less standalone-tool fidelity, but preserves the requested fourth product surface inside Axon rather than creating a disconnected demo.
  Follow-up: revisit only if Design becomes a separately packaged product.

- [P3] Branch connectors are orthogonal rules rather than the concept's curved paths.
  Location: Signal Canvas branch spine.
  Evidence: both communicate one brief branching to three generated directions, but the implementation uses crisp rule segments consistent with the current Axon shell.
  Impact: small visual difference with no workflow loss.
  Follow-up: use a purpose-built connector asset or canvas renderer if freeform node movement is implemented.

- [P3] The measured type scale has eight steps rather than the editorial six-to-seven target.
  Location: host shell plus embedded miniature screen previews.
  Evidence: measured sizes are 17, 15, 13.3333, 12, 11, 10, 9, and 7 px. The smallest values are preview-canvas UI chrome rather than reading copy; the interactive §B text-floor exception applies.
  Impact: acceptable for a desktop design tool whose canvas displays scaled interfaces.
  Follow-up: consolidate the 9 px host-shell remnant if the existing Axon title chrome is retokenized.

## Required fidelity surfaces

- Fonts and typography: the implementation preserves the source's compact technical hierarchy, tight headings, uppercase direction labels, and dense preview text. Reading copy remains distinct from miniature canvas chrome.
- Spacing and layout rhythm: three major tracks, prompt-to-branch alignment, card stacking, inspector density, and bottom prompt dock match the source hierarchy. The first pass left excessive lower-canvas vacancy; the final pass fills the vertical working area without clipping.
- Colors and visual tokens: near-black ranked surfaces, hard gray rules, off-white text, restrained green readiness states, and Axon pink selection/action signals match the visual target.
- Image quality and asset fidelity: the selected generated neural paintbrush asset is used for Axon Design branding; existing Axon neural assets are used for the agent and local workspace. No placeholder imagery is present.
- Copy and content: Local Services CRM, Clarity, Focus, Approachable, Critique, Prototype, Send to Axon Code, and the project brief match the selected concept's product story.

## Interaction and runtime evidence

- Direction selection changed from Focus to Clarity and restored to Focus.
- Critique opened Notes and added a concrete agent note.
- Prototype entered and exited prototype mode.
- Generate branch accepted a new instruction, cleared the prompt, updated the branch summary, and re-enabled its action.
- Browser-button center delta measured `0px` between button center and icon center.
- Runtime console errors: none.
- 1440 measurement: viewport 1441, horizontal overflow 0, minimum tap target 44, largest content gap 0.
- 390 compact measurement: viewport 389, horizontal overflow 0, minimum tap target 44. The canvas remains an intentionally scrollable desktop work surface.

## Comparison history

1. Initial implementation findings: lower-canvas vacancy was materially larger than the source; the vertical branch spine continued below the final direction; toolbar and inspector controls measured 30–38 px.
2. Fixes: stretched the canvas content to the working height, increased direction and screen-preview height, stopped the branch spine at its content boundary, and raised every visible button target to at least 44 px.
3. Post-fix evidence: `01-signal-canvas.png`, `04-final-side-by-side.png`, and the final 1440/390 measurement outputs show the corrected distribution, no page overflow, and 44 px minimum targets.

## Follow-up polish

- A real node graph can replace static connector rules once drag/reorder is in scope.
- The compact 390 px state is structurally safe but is not a separate mobile product target.

final result: passed
