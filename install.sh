#!/usr/bin/env bash
# One-command install/upgrade for dsh-opencode-zen.
#
#   curl -fsSL https://raw.githubusercontent.com/kuraneko1/dsh-opencode-zen/main/install.sh | bash
#
# Env overrides: PROFILE (web) VERSION (0.2.4) SERVICE (1) LAUNCHER (auto: dsh then rdsh)
set -euo pipefail

PROFILE="${PROFILE:-web}"
VERSION="${VERSION:-0.2.4}"
SERVICE="${SERVICE:-1}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
TARBALL="https://github.com/kuraneko1/dsh-opencode-zen/releases/download/v${VERSION}/dsh-opencode-zen-${VERSION}.tgz"

[[ "$PROFILE" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "install: invalid PROFILE '$PROFILE'" >&2; exit 2; }
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "install: invalid VERSION '$VERSION'" >&2; exit 2; }
[[ -f "$DSH_HOME/profiles/$PROFILE/package.json" ]] || { echo "install: no profile '$PROFILE' under $DSH_HOME" >&2; exit 1; }

launcher="${LAUNCHER:-}"
if [[ -z "$launcher" ]]; then
  for candidate in dsh rdsh; do
    if command -v "$candidate" >/dev/null 2>&1; then launcher="$candidate"; break; fi
  done
fi
[[ -n "$launcher" ]] || { echo "install: dsh (or rdsh) not found on PATH" >&2; exit 1; }
for tool in node opencode; do
  command -v "$tool" >/dev/null 2>&1 || { echo "install: $tool not found on PATH" >&2; exit 1; }
done

echo "install: adding dsh-opencode-zen $VERSION to profile '$PROFILE' with $launcher"
if ! "$launcher" plugin --profile "$PROFILE" add "$TARBALL"; then
  cat >&2 <<'HINT'
install: the plugin manager refused the install.
On a fresh profile it can stop on build scripts for DSH's own dependencies: put the keys it
printed under allowBuilds in that profile's pnpm-workspace.yaml (or run `pnpm approve-builds`
in the profile directory), then run this installer again.
HINT
  exit 1
fi

SETUP="$DSH_HOME/profiles/$PROFILE/node_modules/.bin/dsh-opencode-zen-setup"
PROXY="$DSH_HOME/profiles/$PROFILE/node_modules/.bin/dsh-opencode-zen-proxy"
[[ -x "$SETUP" && -x "$PROXY" ]] || { echo "install: the package did not install its commands" >&2; exit 1; }

if [[ "$SERVICE" == "1" ]] && "$SETUP" --install --profile "$PROFILE" --service; then
  echo "install: relay service 'dsh-opencode-zen.service' is running"
  echo "install: stop it with: systemctl --user disable --now dsh-opencode-zen.service"
else
  [[ "$SERVICE" == "1" ]] && echo "install: no systemd user service here; registering without one" >&2
  "$SETUP" --install --profile "$PROFILE"
  echo "install: keep the relay running yourself, for example:"
  echo "  $PROXY run"
fi

cat <<'DONE'
install: done. Pick "OpenCode Zen (free)" in the model selector.
DONE
