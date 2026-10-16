# dsh-opencode-zen

[日本語](<README.ja.md>) · [MIT license](<LICENSE>) · [Security](<SECURITY.md>)

A **native DSH/Cordis provider plugin**, usable through the RDSH launcher, for **OpenCode Zen free models only**.
Not an OpenRouter/NVIDIA/local aggregator, not a second `llm-pi-ai` plugin, and not just a profile-editing script.

Source: <https://github.com/kuraneko1/dsh-opencode-zen> (MIT). npm registry publication is not performed; install from the tarball or the Git repository.

```text
RDSH / DSH → opencode-zen provider → authenticated loopback relay
                                     → isolated OpenCode client → Zen free model
Real tool calls return to the calling harness. OpenCode never executes them.
```

## Requirements and scope

- Linux, Node **22.19+**, an installed `opencode` command.
- Tested: DSH **0.2.0-rc.2**, RDSH **0.4.0**, OpenCode **1.19.0**. DSH peer versions are intentionally pinned; other versions are not promised.
- Text Chat Completions models with tools. Non-Chat models are not falsely advertised as supported.
- The dedicated OpenCode process uses **no Zen API key or copied account credentials**. It enables only the `opencode` provider. Paid or unknown-cost entries are refused.
- You remain responsible for provider terms, availability, quotas and data retention. No client identity spoofing, injected eligibility tools or hidden 403 retries.

## Install the plugin

This package has not been published to npm or a Git hosting service by this work. Build/install its tarball locally; no registry account is needed.

```bash
# From this source directory
npm ci --ignore-scripts
npm test
npm pack

# Install the produced package into an existing DSH/RDSH profile.
# Use dsh instead of rdsh if you do not use the Rust launcher.
rdsh plugin --profile web add /absolute/path/dsh-opencode-zen-0.2.0.tgz

# Or install straight from the Git repository (no tarball needed).
rdsh plugin --profile web add git+https://github.com/kuraneko1/dsh-opencode-zen.git
```

The [bundle declaration](<cordis.patch.yml>) mounts [the actual plugin](<index.mjs>) as `opencode-zen`.
It registers only that provider route, reusing the public `PiAiAdapter` class. It does not call the built-in adapter plugin a second time or replace its provider directory.

### Start the local relay

The relay has a separate lifecycle, so plugin installation does not silently spawn a daemon.
With the standard DSH home/profile layout:

```bash
# Terminal 1. Keep this process running, or configure your own service.
"${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/.bin/dsh-opencode-zen-proxy" run

# Terminal 2. Preview first; apply only when ready.
"${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/.bin/dsh-opencode-zen-setup" --profile web
"${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/.bin/dsh-opencode-zen-setup" --install --profile web
```

The setup CLI stores the **local proxy token**, not a Zen API key, in DSH's `FREEMODELS_API_KEY` credential reference. It preserves unrelated providers, credentials and the default model. Changed files get private backups and use DSH's file locks and atomic writer. Two separate files are not a cross-file transaction; check backups and rerun if setup fails halfway.

If upgrading the earlier all-provider prototype, setup removes **only its `providers.freemodels` route**, including the unwanted OpenRouter/NVIDIA/local registrations, and inserts/configures the native plugin. It does not remove unrelated user-created providers.

Select **OpenCode Zen (free)** in the model selector. A model's wire ID is `zen/<model-id>`; do not hardcode a model that is absent from the current catalog.

A [systemd example](<freemodels-proxy.service>) is included. Adjust its executable/PATH to your installation; no username, checkout path or pinned nvm path is embedded. Node must be on its PATH. Stop uses the verified supervisor identity, not an old arbitrary child PID.

## Configuration

The standard bundle uses these defaults. Only override the existing row if needed:

```yaml
- id: opencode-zen
  config:
    proxyURL: http://127.0.0.1:8099/v1
    apiKeyEnv: FREEMODELS_API_KEY
```

The plugin resolves the named credential through DSH for each operation. Never put a secret in YAML. It discovers the authenticated Zen catalog lazily, shares concurrent refreshes, and refreshes after 60 seconds. Invalid/unavailable discovery does not fall back to stale models. A request already prepared by DSH keeps its captured model generation.

DSH's Web profile can live-reload configuration while HMR is enabled. Installing/replacing package code can require a host restart; do not assume browser refresh alone replaces imported JS.

### Relay state and ports

State lives in `$XDG_STATE_HOME/dsh-opencode-zen`, or `~/.local/state/dsh-opencode-zen`, **outside the npm package**. Parent directory is 0700; tokens are 0600. A writable absolute `FREEMODELS_RUNTIME_DIR` overrides it. No host OpenCode/Hermes authentication files are read or copied.

```bash
OC_PORT=14096 PROXY_PORT=18099 FREEMODELS_RUNTIME_DIR=/absolute/private/state \
  node supervisor.mjs run
node supervisor.mjs status
node supervisor.mjs stop
```

With custom ports, set the plugin's `proxyURL` and pass `--base-url http://127.0.0.1:18099/v1` to setup. Local API token env `FREEMODELS_API_KEY` overrides the state's token file. Old dummy values such as `no-key` are invalid.

## Security boundary

- Public binding is fixed to 127.0.0.1. API calls need the private Bearer token; Host/Origin/browser requests are checked. `/health` only reports cached, non-sensitive state.
- Only `zen/<slug>` requests are accepted. Catalog entries must come from OpenCode's `opencode` provider and publish strictly zero input/output and optional pricing. Unknown pricing schemas fail closed.
- Dedicated HOME/XDG, controlled environment, empty auth file, all tool permissions denied and a single checked OpenCode plugin. Other provider keys are not forwarded.
- Caller tools are forwarded unchanged. Only the caller can execute them; the RDSH tool boundary is never disabled.
- Bounded input/concurrency/SSE parser, byte-preserving streaming, validated completion termination, disconnect cancellation and deadlines. Provider errors and Retry-After are retained. Credentialed redirects are refused.
- Same-user/root compromise, a malicious dependency or OpenCode executable, remote provider internals and guaranteed perpetual free service are **not** covered.

See the current [audit notes](<AUDIT.md>). No claim of perfection is made.

## Development and tests

```bash
npm ci --ignore-scripts
npm test                         # Local mocks only; no real models or provider keys.
npm pack --dry-run --ignore-scripts

# Explicit opt-in live tests, with the relay already running.
node bridge-smoke.mjs
node rdsh-smoke.mjs
```

[The RDSH smoke test](<rdsh-smoke.mjs>) uses a temporary profile and the **native plugin bundle**, not the legacy generic-provider installer. It shares one random test file and uses RDSH's supported `rdsh_inspect` tool with network/write/credential isolation intact. It compares the isolated tool output and final answer to a file-only nonce. If an outer sandbox forbids nested namespaces, run on the host; do not disable RDSH protection to pass.

The npm package uses an explicit `files` allowlist. Runtime data, tokens, authentication, historical benchmarks, personal backups and node_modules are excluded. Test dependencies are declared normally; no source import assumes someone else's DSH runtime checkout.

## Publishing

The source is MIT licensed and public at <https://github.com/kuraneko1/dsh-opencode-zen>.
Run tests and inspect `npm pack --dry-run --ignore-scripts` before sharing.
npm registry publication is not performed by this work; the package is usable from its tarball or Git checkout.
