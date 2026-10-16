# Security policy

Supported/tested combination: dsh-opencode-zen 0.2.x, DSH 0.2.0-rc.2, RDSH 0.4.0, OpenCode 1.19.0, Linux, Node 22.19+.

Report security issues privately through GitHub private vulnerability reporting on
<https://github.com/kuraneko1/dsh-opencode-zen> (Security → Report a vulnerability), or open a minimal issue
that asks for a private channel without attaching sensitive detail. Do not attach live credentials, full DSH
credential stores, runtime directories or unredacted model conversations.

## Boundaries

- Zen free models only. No other provider routes, account-key scans or paid-model fallbacks.
- The host plugin is trusted code. Installing it is not a sandbox against malicious npm dependencies or a malicious OpenCode executable.
- The relay listens only on loopback and requires a private local token. Do not expose it through a public tunnel or bind it to a remote interface.
- The dedicated OpenCode client has isolated HOME/XDG, empty auth, controlled environment and all tool permissions denied. Only the calling harness executes real tools.
- Tokens are stored outside the package in owner-only state. They protect against other untrusted local callers, not a compromised process with the same OS user or root.
- Provider terms, quotas, model availability and data retention remain the provider's responsibility. No free-service or zero-billing guarantee is made from catalog metadata alone.
- Published input/output and optional pricing must be zero. Unknown pricing schemas fail closed until reviewed.
- Normal shutdown removes the dedicated empty auth file; SIGKILL or power loss may leave owner-only state. Persistent local tokens intentionally survive restarts.
- Package contents are allowlisted. Never publish the state directory or personal configuration backups.

Use [the audit notes](<AUDIT.md>) and run `npm test` before releasing. Optional live tests use only an explicitly shared random fixture and must retain the RDSH tool boundary.
