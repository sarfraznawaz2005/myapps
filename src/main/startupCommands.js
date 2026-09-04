'use strict';

const { spawn } = require('child_process');

// Fire-and-forget: runs every enabled command in the background when the
// app starts. Detached + unref'd so a long-running server (e.g. a mail
// client) keeps running independently of this app's own lifecycle.
function runStartupCommands(store) {
  const commands = store.getState().commands || [];
  for (const cmd of commands) {
    if (!cmd.enabled || !cmd.command) continue;
    try {
      const child = spawn(cmd.command, { shell: true, detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => {}); // e.g. command not found — nothing to surface, this is fire-and-forget
      child.unref();
    } catch (_e) { /* ignore */ }
  }
}

module.exports = { runStartupCommands };
