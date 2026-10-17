# Security and compatibility notes — 0.2.12

This is the **Zen-only native-plugin revision**, superseding the local multi-provider prototype. The supported path is [the native plugin](<index.mjs>), [relay](<server.mjs>), [OpenCode fetch hook](<opencode-plugin.mjs>), [bounded bridge](<opencode-bridge.mjs>) and [supervisor](<supervisor.mjs>). No OpenRouter, NVIDIA or local route is implemented.

## Threat model

One trusted OS operator running DSH/RDSH locally, up to four concurrent generations. The relay is not a public or multi-tenant API. Root, a compromised same-user process, malicious OpenCode binaries or a malicious npm dependency are outside this boundary.

OpenCode is **mandatory** and is the only upstream client: Zen's free tier refuses requests that do not come from it. This repository never impersonates that client identity from anywhere else, and never invents tools to satisfy the eligibility check.

## Preserved controls

- Private random local Bearer token; fixed loopback binding; Host/Origin checks; cached non-sensitive health.
- Exact `zen/<slug>` selectors, only the `opencode` provider, strict numeric zero input/output and optional nested prices. Unrecognized pricing data is rejected rather than guessed free. No arbitrary URL or paid-model fallback.
- All external-provider routes and host-credential-file scanners were removed. Dedicated OpenCode auth is empty, no provider API key is forwarded by this code, and only the `opencode` provider is enabled.
- Dedicated HOME/XDG, an allowlisted child environment, all OpenCode tool permissions deny, one checked companion plugin. OpenCode gets no real tool calls to execute; they return to DSH/RDSH.
- Bounded JSON input/concurrency, incremental SSE validation with frame/total bounds, byte-preserving streaming, mandatory valid termination, safe aggregation, backpressure, disconnect cancellation, overall/idle deadlines and bounded cleanup.
- Upstream 403/429/503 and Retry-After remain visible. No invented eligibility tools, client identity impersonation, credentialed redirects or invisible generation retries.
- Supervisor ownership checks compare command and Linux start time before stop. It owns both child handles and waits for real readiness. It refuses foreign/stale PIDs and conflicting ports.
- The generated systemd unit carries absolute, quote-safe paths and only the hardening directives it needs.

## Verified on a live host (0.2.7/0.2.8)

Checked against the running service, not a mock:

- The dedicated OpenCode's `auth.json` is `{}` at 0600, and its data directory holds no host credentials.
- The internal OpenCode server answers `401` without the generated password (`/config`, `/session`).
- The relay answers `401` without its token, `403` for a foreign `Host` and for a browser `Origin`, and `404` for an unknown bridge capability.
- The single-use bridge capability never appears in the service journal (`journalctl --user -u dsh-opencode-zen.service | grep internal/bridge` → 0 matches).
- State directory is 0700 with 0600 key files; the runtime paths are private and created with `O_NOFOLLOW`.

## Findings from this review round (fixed)

1. **A launcher wrapper can add environment variables.** The supervisor passes an explicit allowlist, but `opencode` is launched by name from `PATH`. On this host, `/home/ryu/.local/bin/opencode` is a `/bin/sh` wrapper that exports a variable and `exec`s the real binary, so the running client carried one variable the allowlist never passed (plus the shell's own `PWD`/`SHLVL`). This is now **visible**: after the client is ready, the supervisor reads the child's `/proc/<pid>/environ` and prints the unexpected **names** only — never values — and ignores shell bookkeeping. A test covers a wrapper that exports a variable and asserts the value is absent from the log.
2. **`OPENCODE_BIN` rejected symlinks.** nvm and npm install `opencode` as a symlink, so the documented `OPENCODE_BIN=$(command -v opencode)` was refused by an `lstat`-based check. Now it follows symlinks (`stat`) and still refuses relative, missing or non-executable targets. Regression test uses a symlinked binary.
3. **The installer could rewrite configuration on weak evidence.** `install.sh` repairs a blocking dependency entry; it now rewrites only when the diagnostic names that exact entry (`integrity`/`checksum` plus the current specifier or its basename), refuses a symlinked or non-regular manifest, and resolves relative `file:` specifiers against the manifest directory rather than the working directory.
4. **The setup CLI started the service before validating the profile**, so a bad profile (or a missing row) could leave an enabled, restart-looping relay behind, and the unit pinned no state directory — if the systemd user manager's `XDG_STATE_HOME` differed from the invoking shell's, setup read a different `proxy.key` than the service created. The profile is now validated before any service side effect, and the unit carries `FREEMODELS_RUNTIME_DIR` so both agree.
5. **The isolation check pinned too little.** It verified the plugin list, the global deny and the bridge agent, but a launcher-injected config (or a planted file in the private runtime) could still have added an endpoint override, an extra enabled provider or an MCP server and passed. It now also requires exactly the `opencode` provider (enabled and configured), no `provider.opencode.options` keys, no MCP servers, only the `dsh-bridge` agent, `share: disabled` and `autoupdate: false`. Tests plant an endpoint override, an extra enabled provider and an MCP server and assert each one refuses to start.
6. **`OPENCODE_BIN` was unvalidated in the supervisor** (a bare name, a relative path or a non-executable was accepted there although setup refused them). It now applies the same absolute, executable rule before spawning.
7. **The installer's repair evidence was too loose**: `integrity|checksum` plus a substring match could rewrite the entry on routine output (a bare range such as `^0.2.6` matches text easily). It now requires pnpm's own `ERR_PNPM_TARBALL_INTEGRITY`/`Got unexpected checksum` together with the full `http(s)` specifier verbatim, and ignores anything that is not a pinned URL.
8. **`stateToken` enforced the token file's mode but not the directory's.** The state directory is now `chmod 0700` when it is created or first used.
9. **A republished artifact broke installed profiles.** Re-uploading a tarball at an existing version leaves every profile with a recorded integrity that no longer matches the URL, and pnpm then refuses all operations — correctly. The installer detects that state (from the captured launcher output, since the manager's log holds only the command line) and rewrites only its own dependency entry with a backup. The practice itself is fixed: **released artifacts are immutable; a change gets a new version.**

## Native OSS integration

The host plugin exports normal Cordis `name`, `inject`, `Config` and `apply` values. It subclasses the **public** PiAiAdapter and registers the single `opencode-zen` route. It does not apply another llm-pi-ai instance, write profile configuration, spawn children, register the built-in provider directory again, or rely on a particular user's DSH runtime directory.

The native adapter validates model metadata and capabilities, rejects unknown IDs, lazily shares authenticated catalog discovery with a 60-second TTL, caps catalog bytes and time, fails closed on a failed refresh, resolves credentials per operation, and preserves prepared-call snapshots. It coexists with the actual built-in adapter in tests.

The optional [setup CLI](<setup.mjs>) inserts/configures the native row, stores only a local proxy-token credential reference and removes only the old `freemodels` route. Other providers/defaults/credentials are retained. It uses the host's ordinary public atomic-write dependency, private backups and locks. The two changed files are not one transaction; recover from backups or rerun on a partial failure.

[install.sh](<install.sh>) is the supported one-command path. It validates `PROFILE`/`VERSION`, requires `node` and an executable OpenCode (from `OPENCODE_BIN` or `PATH`), and then delegates to the plugin manager and the setup CLI. It installs from the GitHub release URL, never from a path that can go stale.

The [package manifest](<package.json>) declares a standard bundle, exported entry points, localized display metadata with an original MIT icon, a layout diagram, DSH/pi-ai peer ranges, Linux/Node requirements and an explicit distribution allowlist. [MIT licensing](<LICENSE>) is included. State is outside the installed npm package in private XDG/user state, with an absolute override for testing and service deployments.

OpenCode's plugin loader can select the owning package's server export even for an explicit file URL. The package therefore explicitly exports `./server` as the OpenCode companion hook, while its default export is the DSH host plugin. This packaging distinction is covered by a regression and real startup verification.

## Tests

Run `npm ci --ignore-scripts && npm test` (98 tests). Normal tests use synthetic credentials and local mocks only.

- [Public API regressions](<audit-regression.test.mjs>): only Zen, paid/unknown pricing rejected, unsupported route and SDK rejection, auth/Host/Origin/JSON/size/concurrency checks and no foreign credential reads.
- [Bridge tests](<bridge.test.mjs>): fragmented multibyte SSE, parallel calls, nonstream aggregation, corrupt/partial EOF, limits, prototype keys, usage/reasoning/logprobs, single-use capabilities, statuses, redirects, cancellation and deadlines.
- [Supervisor tests](<supervisor.test.mjs>): anonymous empty auth, isolated HOME/environment, enabled Zen-only provider, private keys/state, readiness, verified stop, stale/foreign PIDs, port conflicts, symlinks, shutdown, failed-isolation cleanup, the launcher-added-variable warning, and refusal of a planted endpoint override, extra provider or MCP server.
- [Native plugin tests](<plugin.test.mjs>): real Cordis/LLM service and built-in coexistence, schema, exact metadata and public-adapter streaming, unknown IDs, prepared snapshots, TTL/concurrent refresh, invalid/missing/rotating credentials, catalog bounds/time/redirects and disposal.
- [Setup tests](<setup.test.mjs>): validation before any service side effect, migration removes mixed legacy route only, default/comment/expression preservation, bundle override vs duplicate insertion, private backups, idempotency and unsafe input refusal. Also covers the generated systemd unit (absolute quote-safe paths only, hardened directives), the `--service` flow through an injected runner, `OPENCODE_BIN` (absolute, executable, symlinked, refused when relative or non-executable) and refusal when `--service` has no `--install` or when OpenCode/`systemctl` is missing.
- [Package tests](<package.test.mjs>): real bundle metadata through DSH's own `readPluginMeta`, split OpenCode/DSH entry points, no machine-specific imports or provider-key readers, the documented version matching the package, the default README being Japanese, the installer's repair logic and actual npm payload excludes state/secrets/history.

Two tests found real defects: the `--service` health wait polled `"/v1/health"` although the relay serves `/health` at the origin root, so a service install could never confirm readiness; and the installer's repair resolved relative `file:` specifiers against the working directory instead of the manifest.

Explicit live checks: [bridge smoke](<bridge-smoke.mjs>) tests tool calls and a client-only random tool result; [RDSH smoke](<rdsh-smoke.mjs>) mounts the actual native bundle in a temporary profile, uses the supported secure `rdsh_inspect`, and checks both isolated output and final text against a file-only nonce. The mandatory RDSH isolation is not disabled. An outer sandbox may forbid nested namespaces, so run that test on the host if necessary.

Launcher independence was verified outside RDSH: a temporary `DSH_HOME` profile was created, the plugin installed with plain `dsh plugin --profile … add`, setup applied, and a real Zen one-shot answered an exact-string prompt. Only the RDSH smoke test needs `rdsh`; the plugin, relay, setup and supervisor never reference it.

## Clean-room install check (0.2.10)

Verified in a `node:22-bookworm` container where **DSH, OpenCode and pnpm were all absent**, following only the
documented one command:

1. `npm i -g @deepseek-ai/dsh@0.2.0-rc.2 opencode-ai` (dsh 0.2.0-rc.2, opencode 1.19.3).
2. `SERVICE=0 bash install.sh` — with no systemd, no profile and no pnpm.

That run now completes: the plugin manager initializes the profile, corepack provides pnpm, the installer
starts the relay in the background and waits for `/health`, then setup registers the row. `dsh --profile web
--dump-config` composes it (`opencode-zen` → `dsh-opencode-zen`, `proxyURL: http://127.0.0.1:8099/v1`) and the
relay reports 10 models. Three defects were found and fixed on the way: an existing profile was required
(although `dsh plugin add` creates one), a missing pnpm only produced a one-line manager notice, and the
`SERVICE=0` path ran setup without a running relay and failed.

**What did not work, and why:** every model request returned `403 FreeTierError`. The same container with a
plain `opencode run` — no config, no plugin, no proxy — returns the identical error on 1.19.3 and on the host's
1.19.0, so it is not this code. Upstream issue #52917 diagnoses the message as **a missing stored OpenCode
(Console) credential**, not an origin restriction, and names `opencode auth login --provider opencode` as the fix, which
other reporters confirm. On this machine `opencode auth list` had no `opencode` entry at all, and the relay's
dedicated client was explicitly anonymous (`{}`). Earlier the same day the lane had answered this relay
anonymously, so the provider tightened it during the session.

Reproducing the fix locally needs a real account, so it stays unverified here. A synthetic credential of either
shape (`api` and `oauth`) did **not** change the error, which is consistent with the server validating the
credential before serving rather than merely requiring its presence, but it means the login itself is the one
step this repository cannot test. The relay now adopts only the `opencode` entry from the operator's store
(never any other provider) and warns when there is none; it still refuses to impersonate the client.

## Context truncation

The published Zen metadata declares only 200k for some free models, and the dedicated OpenCode client truncates input above whatever it declares **without an error** — a long DSH session silently loses history. The relay therefore passes an explicit per-model `limit` for models measured above the published value ([zen-limits.mjs](<zen-limits.mjs>)), and the relay advertises the client's resolved value to DSH.

Measured here against the live relay: `zen/deepseek-v4.1-flash-free` 999,312 prompt tokens (23s) and `zen/glm-5.3-flash-free` 1,047,653 prompt tokens (58s); one earlier GLM run at the same size returned the provider's own 429 "Endpoint is unavailable", which is preserved rather than hidden. Unmeasured models are not raised. [bench-context.mjs](<bench-context.mjs>) re-measures any model.

A related provider behaviour: a request whose only tool has an empty parameter schema is refused with `403 FreeTierError`. This repository does not invent tools to get around it; DSH sends real tool schemas and passes.

## Limits / not checked

- **The upstream free lane needs a stored OpenCode credential.** Confirmed for a plain OpenCode client on two versions and two machines; the relay adopts only that one entry and cannot do more. Nothing here impersonates the client.
- **Port ownership is not authenticated.** Setup sends the relay bearer to whatever holds `127.0.0.1:8099`, and the supervisor's free-port check closes the socket before the client spawns, so a hostile same-user process that wins the race could receive the bearer or the OpenCode Basic password. Both need local code execution as the same user.
- **The private OpenCode config directory is reused across runs.** The resolved-config checks above pin the fields that matter, but a freshly written config is not recreated from scratch every start.
- **The child environment is best-effort.** An allowlist limits what this code forwards, but a launcher wrapper ahead of the real binary can add variables of its own (now reported by name). If a host keeps secrets in such a wrapper, that process sees them. `OPENCODE_BIN` or a clean `PATH` avoids the wrapper entirely.
- **`install.sh` trusts its environment.** `TARBALL`, `LAUNCHER` and `PATH` decide what is executed; it is meant to be run by the operator who owns that shell. It validates `PROFILE`/`VERSION` and refuses non-regular manifests, but it is not a sandbox.
- Text Chat Completions only. Zen models using another wire protocol are excluded, not silently converted through an execution-capable legacy agent.
- No exhaustive all-model, sustained-load, other-version or other-OS certification. Peer ranges intentionally describe the tested runtime, not future compatibility.
- No guarantee that upstream free access, pricing metadata or quotas remain unchanged. Respect provider terms. A no-tools request can return FreeTierError; this is not circumvented.
- Same-user/root access can read or change their own files. Private state is not an OS security boundary against that user.
- No full transitive dependency/supply-chain audit. Do not mistake a lockfile, passing tests or MIT license for proof of dependency safety.
- Power loss/SIGKILL can leave private runtime files. Persistent local proxy/password keys intentionally survive restarts.
- Registry publication is not performed by the setup or tests; releases are immutable GitHub release tarballs under the maintainer's own authorization.
- The generated systemd unit is Linux-only. Other platforms must run the relay themselves; `--service` refuses cleanly rather than writing a broken unit.

Verdict: the active implementation is narrowly Zen-only and packaged as a real native plugin. Keep it local, update deliberately, and preserve visible provider errors.
