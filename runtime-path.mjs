import path from 'node:path';
import os from 'node:os';

// State must remain writable when the installed npm package is read-only.
export function runtimeDirectory(env = process.env) {
  const directory = env.FREEMODELS_RUNTIME_DIR || path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'dsh-opencode-zen');
  if (!path.isAbsolute(directory)) throw new Error('FREEMODELS_RUNTIME_DIR/XDG_STATE_HOME must be absolute');
  return path.resolve(directory);
}
