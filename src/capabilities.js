// A small, provider-neutral contract that keeps the UI, system instruction,
// and browser screenshot gate in agreement. Metadata is resolved by main.js;
// unknown is intentionally conservative for image input.
function modelCapabilityReport({ model, productMode = 'chat', providerKind = 'ollama', advertisedVision = null } = {}) {
  const mode = ['chat', 'code', 'agent'].includes(productMode) ? productMode : 'chat';
  const vision = advertisedVision === true;
  const visionStatus = advertisedVision === true ? 'verified' : advertisedVision === false ? 'not-supported' : 'not-verified';
  const hasWorkspaceTools = mode !== 'chat';
  return {
    model: String(model || 'selected model'),
    providerKind: String(providerKind || 'ollama'),
    mode,
    vision,
    visionStatus,
    attachments: vision,
    workspaceTools: hasWorkspaceTools,
    browser: hasWorkspaceTools,
    browserScreenshot: hasWorkspaceTools && vision,
  };
}

function capabilityInstruction(report) {
  const vision = report.vision ? 'image input is available' : report.visionStatus === 'not-verified' ? 'image input is not verified, so images and screenshots are unavailable' : 'image input is unavailable';
  const workspace = report.mode === 'agent'
    ? `this is Work mode: workspace tools, browser reading, and well-scoped delegation are available${report.browserScreenshot ? ', including visual browser screenshots' : ', but visual browser screenshots are unavailable'}`
    : report.mode === 'code'
      ? `this is Code mode: workspace tools and browser reading are available for focused implementation work${report.browserScreenshot ? ', including visual browser screenshots' : ', but visual browser screenshots are unavailable'}; delegation is unavailable`
      : 'this is Chat mode: workspace tools, browser controls, delegation, and automated task execution are unavailable';
  return [
    `Identity: You are Axon, running the selected model ${report.model}. You are not Claude, ChatGPT, Codex, or another product.`,
    `Capabilities for this turn: ${vision}; ${workspace}.`,
    'Never claim, imply, or role-play an identity or capability that is not listed above. If asked for an unavailable capability, say so plainly and offer the closest supported alternative.',
  ].join('\n');
}

module.exports = { modelCapabilityReport, capabilityInstruction };
