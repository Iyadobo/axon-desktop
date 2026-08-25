// Normalizes browser-related tool calls from the harnesses Axon can host.
// Keeping this outside the renderer makes the auto-open contract testable and
// normalizes legacy and native browser tool names into Axon browser intents.
function browserInvocation(toolName, args = {}) {
  const name = String(toolName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const url = [args.url, args.href, args.target].find((value) => typeof value === 'string' && value.trim());

  if (['webfetch', 'browseropen', 'browsernavigate', 'browsergoto'].includes(name) && url) {
    return { type: 'navigate', url: url.trim() };
  }

  const query = [args.query, args.q, args.search].find((value) => typeof value === 'string' && value.trim());
  if (['websearch', 'browsersearch'].includes(name) && query) {
    return { type: 'navigate', url: 'https://www.google.com/search?q=' + encodeURIComponent(query.trim()) };
  }

  return null;
}

module.exports = { browserInvocation };
