# dsh-opencode-zen

[日本語](<README.md>) · [MIT](<LICENSE>) · [Audit notes](<AUDIT.md>)

A DSH plugin for **OpenCode Zen free models only**. Works with plain `dsh` and through RDSH.

![layout](flow.png)

## Requirements

| Needed | Why |
|---|---|
| **`opencode` command** | **Mandatory.** Zen's free tier only accepts requests from the real OpenCode client; the relay starts it as the upstream client. On `PATH`, or `OPENCODE_BIN=/path/to/opencode` |
| Linux / Node 22.19+ | For the relay (systemd is optional) |
| `pnpm` | Used by the plugin manager. `install.sh` tries to enable it through `corepack`, otherwise it tells you to run `npm i -g pnpm` |

Without OpenCode this plugin cannot work — use a built-in DSH provider such as `deepseek-official` or
`opencode-go` instead.

With no profile yet, `install.sh` lets `dsh plugin` initialize one, and on a machine without systemd
(containers, macOS) it starts the relay in the background instead.

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
dsh plugin --profile web add https://github.com/kuraneko1/dsh-opencode-zen/releases/download/v0.2.18/dsh-opencode-zen-0.2.18.tgz
"${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/.bin/dsh-opencode-zen-setup" --install --profile web --service
```

Then pick **OpenCode Zen (free)** in the model selector. Your default model is not changed.

## The free tier needs a one-time login

```bash
opencode auth login --provider opencode     # sign in once, in a browser
systemctl --user restart dsh-opencode-zen.service   # restart the relay afterwards
```

`403 OpenCode's free tier can only be used from within OpenCode` means **no OpenCode credential is stored**
(upstream issue #52917 reaches the same conclusion and names the login as the fix). Without it, a genuine
OpenCode client gets the same 403.

Note: the form quoted in that issue, `opencode auth login opencode`, **does not work on 1.19.x** — the
positional is parsed as a URL, so it fails with `fetch() URL is invalid`. Pass `--provider` instead.

Of everything stored, the relay adopts **only the `opencode` (Zen/Console) entry** for its dedicated client;
credentials for other providers are never copied. Without a login it starts anonymously and warns.

Context: the anonymous lane used to work without any credential, and the provider has since closed it. The
`opencode` provider takes an **API key** (`OPENCODE_API_KEY`), not OAuth — the documented path is to sign in at
[opencode.ai/auth](https://opencode.ai/auth) and copy a key (the sign-up may ask for billing details; the free
models are priced at 0).

## When you get 403 FreeTierError

Start with the diagnostic (it sends exactly one real request through the relay):

```bash
node zen-doctor.mjs
```

Measured on 2026-10-17: **the same account and the same client version were accepted over an IPv6
egress and refused over IPv4.** This host was refused on IPv4 `219.8.20.246`; z170-desktop succeeded on
IPv6 `2402:6b00:…` (no client impersonation anywhere in this project).

- **Reported IPv4** → enable IPv6 on that network, or use a relay on a host whose egress is accepted:
  ```bash
  ssh -N -L 8099:127.0.0.1:8099 ryu@<that-host>     # its relay, on your local 8099
  ```
  Point DSH at **that host's `proxy.key`** (`dsh-opencode-zen-setup --install --key-file <its key>`).
- A credential (`opencode auth login --provider opencode`) may or may not be needed; anonymous requests
  work on some networks, so a missing credential is not proof of the cause.
- If it still refuses, that is the provider's decision. This plugin does not work around it.

## Good to know

- **Long sessions**: `deepseek-v4.1-flash-free` and `glm-5.3-flash-free` are declared at 1M because they
  measured 999,312 and 1,047,653 prompt tokens. Other models keep the published limit.
- **A text-only request without tools** is refused by the provider with `403 FreeTierError`. DSH always sends
  real tools, so normal use passes.
- **A fresh profile** may ask you to approve build scripts for DSH's own dependencies (`pnpm approve-builds`).
  This plugin has no build scripts.
- Authenticated loopback only. A **Zen credential is now required** (the API key stored by
  `opencode auth login --provider opencode`); the relay adopts that one entry and nothing else. The free models
  themselves cost 0.
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
