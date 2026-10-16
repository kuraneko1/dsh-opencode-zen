# Security and compatibility notes — 0.2.0

This is the **Zen-only native-plugin revision**, superseding the local multi-provider prototype. The supported path is [the native plugin](<index.mjs>), [relay](<server.mjs>), [OpenCode fetch hook](<opencode-plugin.mjs>), [bounded bridge](<opencode-bridge.mjs>) and [supervisor](<supervisor.mjs>). No OpenRouter, NVIDIA or local route is implemented.

## Threat model

One trusted OS operator running DSH/RDSH locally, up to four concurrent generations. The relay is not a public or multi-tenant API. Root, a compromised same-user process, malicious OpenCode binaries or a malicious npm dependency are outside this boundary.

## Preserved controls

- Private random local Bearer token; fixed loopback binding; Host/Origin/browser-request checks; cached non-sensitive health.
- Exact `zen/<slug>` selectors, only the `opencode` provider, strict numeric zero input/output and optional nested prices. Unrecognized pricing data is rejected rather than guessed free. No arbitrary URL or paid-model fallback.
- All external-provider routes and host-credential-file scanners were removed. Dedicated OpenCode auth is empty, no provider API key is inherited, and only the `opencode` provider is enabled.
- Dedicated HOME/XDG, controlled environment, all OpenCode tool permissions deny, one checked companion plugin. OpenCode gets no real tool calls to execute; they return to DSH/RDSH.
- Bounded JSON input/concurrency, incremental SSE validation with frame/total bounds, byte-preserving streaming, mandatory valid termination, safe aggregation, backpressure, disconnect cancellation, overall/idle deadlines and bounded cleanup.
- Upstream 403/429/503 and Retry-After remain visible. No invented eligibility tools, client identity impersonation, credentialed redirects or invisible generation retries.
- Supervisor ownership checks compare command and Linux start time before stop. It owns both child handles and waits for real readiness. It refuses foreign/stale PIDs and conflicting ports.

## Native OSS integration

The host plugin exports normal Cordis `name`, `inject`, `Config` and `apply` values. It subclasses the **public** PiAiAdapter and registers the single `opencode-zen` route. It does not apply another llm-pi-ai instance, write profile configuration, spawn children, register the built-in provider directory again, or rely on a particular user's DSH runtime directory.

The native adapter validates model metadata and capabilities, rejects unknown IDs, lazily shares authenticated catalog discovery with a 60-second TTL, caps catalog bytes and time, fails closed on a failed refresh, resolves credentials per operation, and preserves prepared-call snapshots. It coexists with the actual built-in adapter in tests.

The optional [setup CLI](<setup.mjs>) inserts/configures the native row, stores only a local proxy-token credential reference and removes only the old `freemodels` route. Other providers/defaults/credentials are retained. It uses the host's ordinary public atomic-write dependency, private backups and locks. The two changed files are not one transaction; recover from backups or rerun on a partial failure.

The [package manifest](<package.json>) declares a standard bundle, exported entry points, exact tested DSH/pi-ai peers, Linux/Node requirements and explicit distribution allowlist. [MIT licensing](<LICENSE>) is included. State is outside the installed npm package in private XDG/user state, with an absolute override for testing and service deployments.

OpenCode's plugin loader can select the owning package's server export even for an explicit file URL. The package therefore explicitly exports `./server` as the OpenCode companion hook, while its default export is the DSH host plugin. This packaging distinction is covered by a regression and real startup verification.

## Tests

Run `npm ci --ignore-scripts && npm test`. Normal tests use synthetic credentials and local mocks only.

- [Public API regressions](<audit-regression.test.mjs>): only Zen, paid/unknown pricing rejected, unsupported route and SDK rejection, auth/Host/Origin/JSON/size/concurrency checks and no foreign credential reads.
- [Bridge tests](<bridge.test.mjs>): fragmented multibyte SSE, parallel calls, nonstream aggregation, corrupt/partial EOF, limits, prototype keys, usage/reasoning/logprobs, single-use capabilities, statuses, redirects, cancellation and deadlines.
- [Supervisor tests](<supervisor.test.mjs>): anonymous empty auth, isolated HOME/environment, enabled Zen-only provider, private keys/state, readiness, verified stop, stale/foreign PIDs, port conflicts, symlinks, shutdown and failed-isolation cleanup.
- [Native plugin tests](<plugin.test.mjs>): real Cordis/LLM service and built-in coexistence, schema, exact metadata and public-adapter streaming, unknown IDs, prepared snapshots, TTL/concurrent refresh, invalid/missing/rotating credentials, catalog bounds/time/redirects and disposal.
- [Setup tests](<setup.test.mjs>): migration removes mixed legacy route only, default/comment/expression preservation, bundle override vs duplicate insertion, private backups, idempotency and unsafe input refusal. Also covers the generated systemd unit (absolute quote-safe paths only, hardened directives) and the `--service` flow through an injected runner, plus refusal when `--service` has no `--install` or when `opencode`/`systemctl` is missing.

- [Package tests](<package.test.mjs>): real bundle metadata, split OpenCode/DSH entry points, no machine-specific imports or provider-key readers, and actual npm payload excludes state/secrets/history.

A test of the `--service` health wait found a real defect: it polled `"/v1/health"`, but the relay serves `/health` at the origin root, so a service install could never confirm readiness. Fixed to use the base URL's origin.

Explicit live checks: [bridge smoke](<bridge-smoke.mjs>) tests tool calls and a client-only random tool result; [RDSH smoke](<rdsh-smoke.mjs>) mounts the actual native bundle in a temporary profile, uses the supported secure `rdsh_inspect`, and checks both isolated output and final text against a file-only nonce. The mandatory RDSH isolation is not disabled. An outer sandbox may forbid nested namespaces, so run that test on the host if necessary.

Launcher independence was verified outside RDSH: a temporary `DSH_HOME` profile was created, the plugin installed with plain `dsh plugin --profile … add`, setup applied, and a real Zen one-shot answered an exact-string prompt. Only the RDSH smoke test needs `rdsh`; the plugin, relay, setup and supervisor never reference it.

## Limits / not checked

- Text Chat Completions only. Zen models using another wire protocol are excluded, not silently converted through an execution-capable legacy agent.
- No exhaustive all-model, sustained-load, other-version or other-OS certification. Exact peers intentionally describe the tested runtime, not future compatibility.
- No guarantee that upstream free access, pricing metadata or quotas remain unchanged. Respect provider terms. A no-tools request can return FreeTierError; this is not circumvented.
- Same-user/root access can read or change their own files. Private state is not an OS security boundary against that user.
- No full transitive dependency/supply-chain audit. Do not mistake a lockfile, passing tests or MIT license for proof of dependency safety.
- Power loss/SIGKILL can leave private runtime files. Persistent local proxy/password keys intentionally survive restarts.
- Registry publication is not performed by the setup or tests; releases are GitHub release tarballs under the maintainer's own authorization.
- The generated systemd unit is Linux-only. Other platforms must run the relay themselves; `--service` refuses cleanly rather than writing a broken unit.

Verdict: the active implementation is narrowly Zen-only and packaged as a real native plugin. Keep it local, update deliberately, and preserve visible provider errors.
