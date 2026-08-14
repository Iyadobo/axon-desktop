// Custom slash-command expansion + discovery. Pure of Electron (uses fs/os/path only)
// so it is self-checkable. Claude Code does NOT expand custom slash commands in
// headless -p mode (verified: /relaytest was sent to the model literally, never the
// command body), so the app expands ~/.claude/commands/*.md itself.
// ponytail: $ARGUMENTS / $1..$N + YAML frontmatter only. No $FILE / $WORKDIR / !`shell`.

const fs = require('fs');
const os = require('os');
const path = require('path');

const COMMAND_DIRS = [
  path.join(os.homedir(), '.claude', 'commands'),
  path.join(process.cwd(), '.claude', 'commands'),
];

// Strip a leading YAML frontmatter block (--- ... ---) and return the body.
function stripFrontmatter(body) {
  const m = String(body).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  return m ? body.slice(m[0].length) : body;
}

// Best-effort single-line `description:` from frontmatter (for /help listings).
function frontmatterDescription(body) {
  const m = String(body).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return '';
  const d = m[1].match(/^description:\s*(.+?)\s*$/m);
  return d ? d[1].replace(/^["']|["']$/g, '') : '';
}

// Expand a command body with the given raw arg string.
function expandCommand(body, args) {
  const md = stripFrontmatter(String(body));
  const parts = String(args == null ? '' : args).split(/\s+/).filter(Boolean);
  let out = md.replace(/\$ARGUMENTS/g, String(args == null ? '' : args));
  // (?!\\d) so $1 doesn't eat into $10 / $100.
  parts.forEach((p, i) => { out = out.replace(new RegExp('\\$' + (i + 1) + '(?!\\d)', 'g'), p); });
  return out.trim();
}

function findCommandFile(name, dirs = COMMAND_DIRS) {
  for (const dir of dirs) {
    const f = path.join(dir, name + '.md');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

// Expand a `/cmd args` prompt from a custom command file; unknown -> returned unchanged.
function maybeExpandSlash(prompt, dirs = COMMAND_DIRS) {
  const m = String(prompt).match(/^\/([A-Za-z0-9_:.-]+)(?:\s+(.*))?$/);
  if (!m) return prompt;
  const f = findCommandFile(m[1], dirs);
  if (!f) return prompt; // unknown -> pass through to the model verbatim
  return expandCommand(fs.readFileSync(f, 'utf8'), m[2] || '');
}

function listCommands(dirs = COMMAND_DIRS) {
  const seen = new Set(), out = [];
  for (const dir of dirs) {
    let files = []; try { files = fs.readdirSync(dir); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const name = file.slice(0, -3);
      if (seen.has(name)) continue; seen.add(name);
      let desc = ''; try { desc = frontmatterDescription(fs.readFileSync(path.join(dir, file), 'utf8')); } catch {}
      out.push({ name, description: desc });
    }
  }
  return out;
}

module.exports = { expandCommand, stripFrontmatter, frontmatterDescription, maybeExpandSlash, listCommands, COMMAND_DIRS };