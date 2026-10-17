# dsh-opencode-zen

[日本語](<README.md>) · [MIT](<LICENSE>) · [Audit notes](<AUDIT.md>)

A DSH plugin for **OpenCode Zen free models only**. Works with plain `dsh` and through RDSH.
Real tools run only in the calling harness; the upstream OpenCode client only relays.

## Requirements

Linux, Node 22.19+, and the **`opencode` command** (on `PATH`, or `OPENCODE_BIN=/path/to/opencode`).
Zen's free tier only accepts requests from the real OpenCode client, so it is the upstream client.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/kuraneko1/dsh-opencode-zen/main/install.sh | bash
```

By default it installs into the `web` profile and runs the relay as a systemd user service.

| To change | How |
|---|---|
| another profile | `PROFILE=tui bash install.sh` |
| no service | `SERVICE=0 bash install.sh` (then run `dsh-opencode-zen-proxy run` yourself) |
| stop the relay | `systemctl --user disable --now dsh-opencode-zen.service` |

Manual install:

```bash
dsh plugin --profile web add https://github.com/kuraneko1/dsh-opencode-zen/releases/download/v0.2.5/dsh-opencode-zen-0.2.5.tgz
"${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/.bin/dsh-opencode-zen-setup" --install --profile web --service
```

Then pick **OpenCode Zen (free)** in the model selector. Your default model is not changed.

## Good to know

- **Long sessions**: `deepseek-v4.1-flash-free` and `glm-5.3-flash-free` are declared at 1M because they measured
  999,312 and 1,047,653 prompt tokens. Other models keep the published limit. Re-measure with
  `node bench-context.mjs zen/<id> 250000`.
- **A text-only request without tools** is refused by the provider with `403 FreeTierError`. DSH always sends
  real tools, so normal use passes.
- **A fresh profile** may ask you to approve build scripts for DSH's own dependencies (`pnpm approve-builds`).
  This plugin has no build scripts.
- Authenticated loopback only. The local relay token lives in `~/.local/state/dsh-opencode-zen` (0600); **no
  Zen API key is needed**.
- No guarantee of perpetual free access, of every model, or of future DSH versions.

### Advanced

- **Other install routes**: the Web **Plugins** page or the agent's `plugin_manager` tool can install the
  release tarball URL directly, with a build-approval prompt and rollback.
- **Compatibility**: `engines.dsh` and the enforced peers declare `^0.2.0-rc.2`. A different prerelease needs an
  exact exemption — `dsh plugin --profile web allow-version dsh-opencode-zen@<version> --dsh-version <runtime> --accept-risk`.
- **State/ports**: `$FREEMODELS_RUNTIME_DIR` or `~/.local/state/dsh-opencode-zen`; `OC_PORT`/`PROXY_PORT`
  (defaults 4096/8099). Change the plugin row's `proxyURL` and setup's `--base-url` to match.
- **Extending limits**: `FREEMODELS_ZEN_LIMITS='{"<model-id>":{"context":N,"output":N}}'` on the relay.

See [AUDIT.md](<AUDIT.md>) for the security boundary, measurements and known limits, and
[CHANGELOG.md](<CHANGELOG.md>) for history.
