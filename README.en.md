# dsh-opencode-zen

[日本語](<README.md>) · [MIT](<LICENSE>) · [Audit notes](<AUDIT.md>)

A DSH plugin for **OpenCode Zen free models only**. Works with plain `dsh` and through RDSH.

![layout](flow.png)

## Requirements

| Needed | Why |
|---|---|
| **`opencode` command** | **Mandatory.** Zen's free tier only accepts requests from the real OpenCode client; the relay starts it as the upstream client. On `PATH`, or `OPENCODE_BIN=/path/to/opencode` |
| Linux / Node 22.19+ | For the relay and its systemd service |

Without OpenCode this plugin cannot work — use a built-in DSH provider such as `deepseek-official` or
`opencode-go` instead.

## Ports

| Port | Purpose | Override |
|---|---|---|
| **8099** | The only endpoint your app talks to (local relay). Token required | `PROXY_PORT` |
| 4096 | The dedicated OpenCode the relay starts internally. Nothing connects to it directly | `OC_PORT` |
| — | Local token and state (0600) | `FREEMODELS_RUNTIME_DIR` |

Defaults are 8099 and 4096, with state in `~/.local/state/dsh-opencode-zen`. When you change the relay port,
pass `--base-url http://127.0.0.1:<PROXY_PORT>/v1` to `dsh-opencode-zen-setup` as well.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/kuraneko1/dsh-opencode-zen/main/install.sh | bash
```

| To change | How |
|---|---|
| another profile | `PROFILE=tui bash install.sh` |
| no service | `SERVICE=0 bash install.sh` |
| point at a specific OpenCode | `OPENCODE_BIN=/opt/opencode/opencode bash install.sh` |
| stop the relay | `systemctl --user disable --now dsh-opencode-zen.service` |

Manual install:

```bash
dsh plugin --profile web add https://github.com/kuraneko1/dsh-opencode-zen/releases/download/v0.2.8/dsh-opencode-zen-0.2.8.tgz
"${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/.bin/dsh-opencode-zen-setup" --install --profile web --service
```

Then pick **OpenCode Zen (free)** in the model selector. Your default model is not changed.

## Good to know

- **Long sessions**: `deepseek-v4.1-flash-free` and `glm-5.3-flash-free` are declared at 1M because they
  measured 999,312 and 1,047,653 prompt tokens. Other models keep the published limit.
- **A text-only request without tools** is refused by the provider with `403 FreeTierError`. DSH always sends
  real tools, so normal use passes.
- **A fresh profile** may ask you to approve build scripts for DSH's own dependencies (`pnpm approve-builds`).
  This plugin has no build scripts.
- Authenticated loopback only, and **no Zen API key is needed** — only a generated local relay token.
- No guarantee of perpetual free access, of every model, or of future DSH versions.

### Advanced

- **Other install routes**: the Web **Plugins** page or the agent's `plugin_manager` tool can install the
  release tarball URL directly, with a build-approval prompt and rollback.
- **Compatibility**: `engines.dsh` and the enforced peers declare `^0.2.0-rc.2`. A different prerelease needs an
  exact exemption — `dsh plugin --profile web allow-version dsh-opencode-zen@<version> --dsh-version <runtime> --accept-risk`.
- **Extending limits**: `FREEMODELS_ZEN_LIMITS='{"<model-id>":{"context":N,"output":N}}'` on the relay, after
  measuring with `node bench-context.mjs zen/<model-id> 250000`.

See [AUDIT.md](<AUDIT.md>) for the security boundary, measurements and known limits, and
[CHANGELOG.md](<CHANGELOG.md>) for history.
