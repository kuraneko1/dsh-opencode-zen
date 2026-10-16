import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

// State must remain writable when the installed npm package is read-only.
export function runtimeDirectory(env = process.env) {
  const directory = env.FREEMODELS_RUNTIME_DIR || path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'dsh-opencode-zen');
  if (!path.isAbsolute(directory)) throw new Error('FREEMODELS_RUNTIME_DIR/XDG_STATE_HOME must be absolute');
  return path.resolve(directory);
}

/** Create or validate one owner-only 64-hex local token. Shared by the relay and setup. */
export function stateToken(directory, name) {
  const file = path.join(directory, name);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const fd = fs.openSync(file,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, `${randomBytes(32).toString('hex')}\n`); }
    finally { fs.closeSync(fd); }
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error(`${name} must be a private regular file (0600)`);
  const value = fs.readFileSync(file, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`invalid ${name}`);
  return value;
}
