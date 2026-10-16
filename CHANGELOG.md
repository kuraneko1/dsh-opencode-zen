# Changelog

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
