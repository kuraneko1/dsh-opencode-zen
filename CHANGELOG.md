# Changelog

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
