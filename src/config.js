const fs = require('fs');
const path = require('path');

const STATE_KEYS = new Set(['osettings', 'oprojects', 'oconvs', 'omodel', 'olanHost', 'oactiveProject', 'odraft', 'oworkspace', 'osharedConvs', 'ocloudModels']);

function createConfigStore(userDataPath) {
  const file = path.join(userDataPath, 'settings.json');
  const backup = path.join(userDataPath, 'settings.backup.json');

  function read() {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
      try {
        const value = JSON.parse(fs.readFileSync(backup, 'utf8'));
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      } catch { return {}; }
    }
  }

  function write(state) {
    fs.mkdirSync(userDataPath, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(temp, file);
    fs.writeFileSync(backup, JSON.stringify(state, null, 2), 'utf8');
  }

  return {
    load: () => read(),
    save: (updates) => {
      if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return read();
      const next = read();
      for (const [key, value] of Object.entries(updates)) {
        if (!STATE_KEYS.has(key)) continue;
        if (value === undefined) delete next[key];
        else next[key] = value;
      }
      write(next);
      return next;
    },
  };
}

module.exports = { createConfigStore, STATE_KEYS };
