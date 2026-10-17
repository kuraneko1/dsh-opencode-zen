# Changelog

## 0.2.14

- The relay start wait is bounded by wall-clock (150s, 3s probes) instead of 120 attempts with 1s
  probes. On a cold cache the OpenCode client fetches its model metadata before answering, so a
  fresh machine could exhaust the old window while the server was still working — measured while
  building the sandbox image, where the relay reported "did not become healthy" after 61s.

## 0.2.13

- Correct a claim the provider invalidated: a Zen credential **is** required now. The anonymous lane that this
  plugin originally relied on has been closed, and the `opencode` provider's credential is an API key
  (`OPENCODE_API_KEY`, from opencode.ai/auth), not OAuth. READMEs and AUDIT.md say so, including that the free
  models themselves cost 0 and that the relay adopts only that one entry.

## 0.2.12

- Correct the documented login command to `opencode auth login --provider opencode`. The positional form quoted
  in upstream issue #52917 is parsed as a *url* by OpenCode 1.19.x and fails with
  `Failed to load auth provider metadata from opencode: fetch() URL is invalid` — reproduced in a clean
  container on 1.19.3 as well, so it is not a local misconfiguration. `opencode auth login` (interactive
  selection) also works.

## 0.2.11

- The `403 FreeTierError` is upstream's way of reporting **no stored OpenCode credential** (issue #52917); a
  genuine OpenCode client gets it too. The relay now adopts the operator's stored `opencode` (Zen/Console)
  entry for its dedicated client — that entry only, never their other providers — and warns when there is
  none, instead of always running anonymously.
- Setup reports `zenCredential` and prints the one-time `opencode auth login --provider opencode` step; the generated
  unit pins `OPENCODE_AUTH_FILE` so the service reads the same store.
- `OPENCODE_AUTH_FILE` overrides the store path for relocated setups.

## 0.2.10

Verified by installing from scratch in a clean container with DSH, OpenCode and pnpm all absent:

- `install.sh` no longer requires an existing profile: `dsh plugin` initializes one, and the installer says so.
- It checks for pnpm and enables it through corepack when possible, with `npm i -g pnpm` as the fallback,
  instead of letting the plugin manager fail with a one-line notice.
- Without systemd the installer now starts the relay itself, waits for `/health`, and only then registers the
  provider (previously setup ran against a relay that was not running and failed).
- READMEs list pnpm and explain the provider-side `FreeTierError`, which a plain OpenCode client also receives.

## 0.2.9

Independent review follow-ups (the confirmations from the same pass are listed in AUDIT.md):

- Validate the profile **before** starting the relay service, and pin `FREEMODELS_RUNTIME_DIR` in the unit, so
  a bad profile cannot leave a restart-looping relay and setup cannot read a different `proxy.key` than the
  service created.
- The resolved-config isolation check now pins the provider set, missing endpoint overrides, MCP servers,
  the agent set, `share` and `autoupdate`. Tests plant each tamper and assert startup is refused.
- The supervisor validates `OPENCODE_BIN` like setup does (absolute, executable), instead of accepting a bare
  name or a relative path resolved against the private work directory.
- The installer's repair only reacts to pnpm's own integrity error naming that exact pinned URL; loose
  `integrity|checksum` text can no longer rewrite the entry.
- `stateToken` now enforces 0700 on the state directory, not only 0600 on the token file.

## 0.2.8

- The READMEs now lead with the mandatory OpenCode requirement and a port table, and embed a simple layout PNG
  (`flow.png`) so the roles of 8099 (the only endpoint your app uses) and 4096 (internal, started by the relay)
  are obvious at a glance.
- Review finding: a launcher wrapper on `PATH` can export variables the allowlist never passed (observed live:
  `/home/ryu/.local/bin/opencode` is such a wrapper). The supervisor now reports the unexpected variable
  **names** once the client is ready, never their values.
- Review finding: `OPENCODE_BIN` rejected symlinks, which is how nvm and npm install the command. It now
  follows symlinks while still refusing relative, missing or non-executable targets.
- `install.sh` refuses to rewrite a symlinked manifest, and `AUDIT.md` documents the environment and installer
  limits alongside the live checks (401/403/404 probes, empty auth, clean journal, 0700/0600 state).

## 0.2.7

- The manager's operation log holds only the command line, so the repair now takes its evidence from the
  captured installer output as well. Without that, an integrity mismatch could not be recognised and the
  recovery path added in 0.2.6 never ran. A test covers both evidence sources.

## 0.2.6

- Released artifacts are immutable: never re-upload a tarball at an existing version. Doing that leaves every
  installed profile with a recorded integrity that no longer matches the URL, and pnpm then correctly refuses
  to continue. This happened while preparing 0.2.5, so this release fixes the recovery path rather than
  rewriting 0.2.5 again.
- `install.sh` now repairs both blocking states by rewriting only its own dependency entry (with a backup):
  a deleted local `file:` tarball, and an integrity mismatch recorded for a URL. When it sees the latter it
  says so, because a changed artifact is exactly what a tampering signal looks like.

## 0.2.5

- `OPENCODE_BIN` now works for the systemd service path too: the unit carries that binary's directory, and a
  relative or non-executable value is refused. `install.sh` accepts it as well and says so when OpenCode is missing.
- Both READMEs state the OpenCode requirement up front, since Zen's free tier only accepts that client.

## 0.2.4

- `README.md` is Japanese now (the default page); English moved to `README.en.md`. Both are short, and the
  detail lives in `AUDIT.md`.
- Add `install.sh`: one command installs or upgrades the plugin, registers it and starts the relay service.
  `PROFILE`, `VERSION`, `SERVICE` and `LAUNCHER` override the defaults.

## 0.2.3

- Declare the standard DSH author fields: `dsh.manifestVersion: 1` and `engines.dsh`.
- Add localized display metadata (`locale/en.json`, `locale/ja.json`) and an original MIT-licensed
  `icon.svg`, so the Plugins page and cards show a real title, description and artwork instead of the raw
  package name. Both are exported and included in the package payload.
- Relax the enforced DSH peers from an exact prerelease pin to `^0.2.0-rc.2`, and `@earendil-works/pi-ai` to
  `^0.87.1`, so a compatible DSH patch release no longer needs a new plugin release. A different prerelease
  still needs an exact exemption in the profile's `compatibility.json`.
- Document the Web Plugins page and `plugin_manager` install routes and the exemption commands.

## 0.2.2

- Restore the measured long-context behaviour: the dedicated OpenCode client now gets an explicit per-model
  `limit`, because the published Zen metadata declares only 200k and the client otherwise truncates long input
  silently. `zen/deepseek-v4.1-flash-free` measured 999,312 prompt tokens and `zen/glm-5.3-flash-free`
  1,047,653 prompt tokens (previously both declared 200000).
- Unmeasured models keep the catalogue value; `FREEMODELS_ZEN_LIMITS` extends the measured table, and
  [bench-context.mjs](bench-context.mjs) measures a model against the live relay.
- Documented that the free-tier gate rejects a placeholder tool with an empty schema (403 FreeTierError); a
  realistic tool schema, as DSH sends, passes.

## 0.2.1

- Easier install: `dsh-opencode-zen-setup --install --profile web --service` now generates, enables and health-checks the relay's systemd user unit, so a full install is two commands.
- Confirmed launcher independence: the plugin, relay and setup work with plain `dsh`; only the optional RDSH smoke test uses RDSH.
- Fixed a silent no-op: the CLI entry guard compared a symlink path with its target, so invoking either CLI through `node_modules/.bin` did nothing. Real paths are compared now, and a bin-shim regression test covers both binaries.
- Fixed the `--service` readiness check, which polled `/v1/health` instead of the origin's `/health` and could never confirm startup.
- `@deepseek-ai/dsh-atomic-write` is a normal dependency now, because setup runs under bare Node where launcher-resolved peers do not exist. A test asserts bare-node entry points never import host-provided peers.
- Removed the hand-edited systemd example; the unit is generated from resolved absolute paths. `git+https://` installs are documented as blocked by pnpm build approval.

## 0.2.0 — first public source release

- Published as public source at <https://github.com/kuraneko1/dsh-opencode-zen>. npm registry publication is not performed.
- Scope restricted to OpenCode Zen free models. Removed OpenRouter, NVIDIA and local routes and all provider-credential copying/scanning.
- Added a real DSH/Cordis plugin with the unique opencode-zen route, using public adapter APIs rather than a duplicate llm-pi-ai instance.
- Added a standard bundle, normal npm/peer dependencies, portable CLIs, MIT license and publication allowlist.
- State now uses XDG/private user state outside the installed package; no hardcoded username/runtime checkout is needed.
- Setup migrates the old freemodels route without changing unrelated providers or the default model.
- Preserved authenticated loopback-only operation, bounded validated SSE, cancellation, deny-all OpenCode permissions and supervised lifecycle.

## 0.1.0 — local prototype

The previous local all-provider prototype and its archive are superseded. It was not a reusable native provider plugin and is not the supported distribution.
