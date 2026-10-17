#!/usr/bin/env bash
# One-command install/upgrade for dsh-opencode-zen.
#
#   curl -fsSL https://raw.githubusercontent.com/kuraneko1/dsh-opencode-zen/main/install.sh | bash
#
# Env overrides: PROFILE (web) VERSION (0.2.12) SERVICE (1) LAUNCHER (auto: dsh then rdsh) TARBALL
set -euo pipefail

PACKAGE="dsh-opencode-zen"
PROFILE="${PROFILE:-web}"
VERSION="${VERSION:-0.2.12}"
SERVICE="${SERVICE:-1}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
MANIFEST="$DSH_HOME/profiles/$PROFILE/package.json"
TARBALL="${TARBALL:-https://github.com/kuraneko1/dsh-opencode-zen/releases/download/v${VERSION}/dsh-opencode-zen-${VERSION}.tgz}"

# --- repair: begin -----------------------------------------------------------
# Two states block every later pnpm operation, so this rewrites only our own entry:
#   1. a `file:` specifier whose tarball was deleted
#   2. a recorded integrity that no longer matches the URL (an asset was republished in place)
repair_blocking_dependency() {
  node - "$MANIFEST" "$TARBALL" "$PACKAGE" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [file, url, name] = process.argv.slice(2);
const logRoot = path.join(path.dirname(file), '.plugin-manager', 'logs');
// Write only through a regular file: the rest of this project refuses symlinked configuration too.
const info = fs.lstatSync(file, { throwIfNoEntry: false });
if (info === undefined) process.exit(1); // No manifest yet: nothing to repair.
if (info.isSymbolicLink() || !info.isFile()) {
  console.error(`install: refusing to rewrite a non-regular manifest: ${file}`);
  process.exit(1);
}
const raw = fs.readFileSync(file, 'utf8');
const manifest = JSON.parse(raw);
const field = ['dependencies', 'devDependencies'].find((key) => typeof manifest[key]?.[name] === 'string');
if (field === undefined) process.exit(1);
const current = manifest[field][name];

// A relative file: specifier belongs to the manifest, not to the current directory.
const localMissing = () => {
  if (!current.startsWith('file:')) return false;
  const target = current.slice('file:'.length);
  return !fs.existsSync(path.isAbsolute(target) ? target : path.resolve(path.dirname(file), target));
};
// pnpm keeps the manager's diagnostics in the newest operation log. Only trust it when it
// names this exact entry: an unrelated failure must not rewrite a deliberate local pin.
const evidence = () => {
  const parts = [process.env.PNPM_OUTPUT ?? ''];
  try {
    const newest = fs.readdirSync(logRoot).map((entry) => path.join(logRoot, entry, 'pnpm.log'))
      .filter((candidate) => fs.existsSync(candidate))
      .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0];
    if (newest !== undefined) parts.push(fs.readFileSync(newest, 'utf8'));
  } catch { /* No logs is not evidence. */ }
  return parts.join('\n');
};
const integrityMismatch = () => {
  // Only a pinned remote tarball can carry a stale integrity, and pnpm names the full URL in
  // ERR_PNPM_TARBALL_INTEGRITY. A bare version range would match a substring far too easily.
  if (!/^https?:\/\//.test(current) || current === url) return false;
  const text = evidence();
  return /ERR_PNPM_TARBALL_INTEGRITY|Got unexpected checksum/i.test(text) && text.includes(current);
};
const reason = localMissing() ? 'the local tarball is gone' : integrityMismatch() ? 'the published tarball no longer matches the locked integrity' : undefined;
if (reason === undefined) process.exit(1);
manifest[field][name] = url;
// The backup name is guessable, so create it exclusively: a pre-created symlink there must make
// this fail rather than redirect the copy into somebody else's file.
const backup = `${file}.bak-opencode-zen-${Date.now()}`;
try {
  const fd = fs.openSync(backup, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, raw); } finally { fs.closeSync(fd); }
} catch (error) {
  console.error(`install: no backup written (${error.code}); continuing`);
}
// And never follow a symlink for the manifest itself, even if it was swapped in after the check.
const out = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW);
try { fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`); } finally { fs.closeSync(out); }
console.error(`install: rewrote ${name} to ${url} because ${reason}`);
NODE
}
# --- repair: end -------------------------------------------------------------

[[ "$PROFILE" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "install: invalid PROFILE '$PROFILE'" >&2; exit 2; }
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "install: invalid VERSION '$VERSION'" >&2; exit 2; }
if [[ ! -f "$MANIFEST" ]]; then
  echo "install: no profile '$PROFILE' yet; the plugin manager will initialize one"
fi

launcher="${LAUNCHER:-}"
if [[ -z "$launcher" ]]; then
  for candidate in dsh rdsh; do
    if command -v "$candidate" >/dev/null 2>&1; then launcher="$candidate"; break; fi
  done
fi
[[ -n "$launcher" ]] || { echo "install: dsh (or rdsh) not found on PATH" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "install: node not found on PATH" >&2; exit 1; }
# Zen's free tier only accepts the real OpenCode client, so its binary is required.
if [[ -n "${OPENCODE_BIN:-}" ]]; then
  [[ -x "$OPENCODE_BIN" ]] || { echo "install: OPENCODE_BIN is not executable: $OPENCODE_BIN" >&2; exit 1; }
else
  command -v opencode >/dev/null 2>&1 \
    || { echo "install: opencode not found on PATH; install OpenCode or set OPENCODE_BIN to its binary" >&2; exit 1; }
fi
# The plugin manager installs bundles with pnpm; without it the manager only says so in passing.
if ! command -v pnpm >/dev/null 2>&1 && command -v corepack >/dev/null 2>&1; then
  echo "install: enabling pnpm through corepack"
  corepack enable pnpm >/dev/null 2>&1 || corepack prepare pnpm@latest --activate >/dev/null 2>&1 || true
fi
command -v pnpm >/dev/null 2>&1 \
  || { echo "install: pnpm is required by the plugin manager; install it with 'npm i -g pnpm' (or 'corepack enable pnpm')" >&2; exit 1; }

echo "install: adding $PACKAGE $VERSION to profile '$PROFILE' with $launcher"
# The manager's own log holds only the command line, so capture its output as the evidence
# the repair needs (it also still reads the newest log as a fallback).
add_output=""
if ! add_output="$("$launcher" plugin --profile "$PROFILE" add "$TARBALL" 2>&1)"; then
  printf '%s\n' "$add_output" >&2
  if PNPM_OUTPUT="$add_output" repair_blocking_dependency; then
    echo "install: retrying the install"
    if ! add_output="$("$launcher" plugin --profile "$PROFILE" add "$TARBALL" 2>&1)"; then
      printf '%s\n' "$add_output" >&2
      echo "install: still refused; see the diagnostics above and re-run" >&2
      exit 1
    fi
  else
    cat >&2 <<'HINT'
install: the plugin manager refused the install.
On a fresh profile it can stop on build scripts for DSH's own dependencies: put the keys it
printed under allowBuilds in that profile's pnpm-workspace.yaml (or run `pnpm approve-builds`
in the profile directory), then run this installer again.
HINT
    exit 1
  fi
fi

SETUP="$DSH_HOME/profiles/$PROFILE/node_modules/.bin/dsh-opencode-zen-setup"
PROXY="$DSH_HOME/profiles/$PROFILE/node_modules/.bin/dsh-opencode-zen-proxy"
[[ -x "$SETUP" && -x "$PROXY" ]] || { echo "install: the package did not install its commands" >&2; exit 1; }

RUNTIME_DIR="${FREEMODELS_RUNTIME_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/dsh-opencode-zen}"
BASE_URL="${BASE_URL:-http://127.0.0.1:8099/v1}"
relay_healthy() { curl -fsS --max-time 2 "${BASE_URL%/v1}/health" >/dev/null 2>&1; }
wait_for_relay() { for _ in $(seq 1 60); do relay_healthy && return 0; sleep 1; done; return 1; }

if [[ "$SERVICE" == "1" ]] && "$SETUP" --install --profile "$PROFILE" --base-url "$BASE_URL" --service; then
  echo "install: relay service 'dsh-opencode-zen.service' is running"
  echo "install: stop it with: systemctl --user disable --now dsh-opencode-zen.service"
else
  # No systemd here (containers, macOS) or the service failed: own a background relay instead,
  # because setup cannot read the token or the catalog before the relay is actually up.
  if [[ "$SERVICE" == "1" ]]; then
    echo "install: no systemd user service here; using a background relay" >&2
  fi
  if relay_healthy; then
    echo "install: a relay is already answering at $BASE_URL"
  else
    mkdir -p "$RUNTIME_DIR"
    nohup "$PROXY" run >"$RUNTIME_DIR/relay.log" 2>&1 &
    echo "$!" >"$RUNTIME_DIR/relay.pid"
    echo "install: started the relay (pid $!), log: $RUNTIME_DIR/relay.log"
    wait_for_relay || { echo "install: the relay did not become healthy; see $RUNTIME_DIR/relay.log" >&2; exit 1; }
  fi
  "$SETUP" --install --profile "$PROFILE" --base-url "$BASE_URL"
  echo "install: the relay keeps running in the background; stop it with: $PROXY stop"
fi

echo "install: done. Pick \"OpenCode Zen (free)\" in the model selector."
