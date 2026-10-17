import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The free tier is served by OpenCode's own provider and, since the provider tightened the lane,
// it answers "free tier can only be used from within OpenCode" for anonymous requests. The user
// therefore signs in once with `opencode auth login opencode`, and the relay adopts that single
// entry so its dedicated client is not anonymous.

/** Where the operator's own OpenCode keeps provider credentials. */
export function opencodeAuthFile(env = process.env, home = os.homedir()) {
  const explicit = env.OPENCODE_AUTH_FILE;
  if (explicit !== undefined && explicit !== '') {
    if (!path.isAbsolute(explicit)) throw new Error('OPENCODE_AUTH_FILE must be an absolute path');
    return explicit;
  }
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'opencode', 'auth.json');
}

/** Only the free-tier provider entry is adopted; every other stored credential stays out. */
export function readFreeTierCredential(file) {
  try {
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'))?.opencode;
    return entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? { opencode: entry } : null;
  } catch {
    return null; // A missing or unreadable store simply means anonymous.
  }
}
