# Calcium desktop-layout QA

## Comparison target

- Source visual truth: `C:\Users\Iyad\.codex\attachments\82f0519a-4218-43f0-af21-2321a7542a32\image-1.png`
- Implementation: `C:\Users\Iyad\ollama-desktop-harness\scripts\audit-shell-1440-chat-code.png`
- Same implementation state: Code empty workspace, dark theme, no selected project.
- Viewport: 1440 x 900 CSS px at the preview's 1.25 device scale factor.
- Source pixels: 1917 x 974. Implementation pixels: 1800 x 949. The full-view comparison normalizes both captures to a shared 949 px height: `scripts/design-qa-comparison.png`.

## Comparison history

### Pass 1 — blocked

- Finding [P1]: Code led with a large decorative fake editor, which competed with the actual composer and made the empty state read as a prototype rather than a desktop working surface.
- Fix: replaced it with a compact working-set strip plus real Inspect, Debug, and Test actions; reduced red elevation and removed the ambient accent glow.
- Finding [P1]: Settings floated beside an absent application rail instead of becoming a full configuration workspace.
- Fix: removed settings' artificial sidebar offset so its own navigation rail owns the full page.

### Pass 2 — post-fix evidence

- The Code canvas now has one dominant action surface (the real composer), a compact project context, fixed top chrome, and the existing real side rail.
- The full-page Settings capture at `scripts/audit-shell-1440-settings.png` has a dedicated left settings rail and no orphaned application-sidebar gutter.
- The focused mobile Code capture at `scripts/audit-shell-390-chat-code.png` confirms that the working-set controls and compact permission/reasoning controls remain readable without horizontal overflow.

## Required fidelity surfaces

- **Typography:** The same existing Segoe/Cascadia system remains in use. The revised Code hierarchy reduces the oversized top panel and keeps the task heading as the primary reading target.
- **Spacing and layout rhythm:** The full-view comparison shows the Code surface collapsed from a second dashboard-sized region into a 50 px working-set strip. The composer is now adjacent to its context instead of separated by a competing panel.
- **Colors and tokens:** The black/neutral rule system is retained; red is now limited to selection, status, and the send action rather than a canvas glow and tab underline.
- **Image quality and assets:** The existing Calcium bone asset remains the only product mark; no visual asset was substituted or approximated.
- **Copy and content:** The Code context uses actual app actions and the selected project name. No fabricated code output remains in the empty state.

## Residual notes

- The supplied source is a prior Calcium Code capture, not a separate Codex Desktop screenshot. The deliberate deviations in this pass are the requested Codex-like desktop hierarchy: quiet chrome, compact context, a functional left rail, and a single dominant composer.
- No P0, P1, or P2 issue remains in the checked Code, Work, Settings, and narrow Code states.

## Final result

passed
