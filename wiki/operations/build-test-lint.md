# Build, test, lint

All commands verified during wiki generation. Run from the project root.

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `npm install` | exit 0 |
| Test | `npm test` | 411 pass, 0 fail |
| Parity matrix | `node test/parity-matrix.mjs --check` | `35/35 covered` |
| E2E test | `node test/e2e-local.test.js` | exit 0 |
| Syntax check | `node --check index.js && for f in $(find . -name '*.js' -not -path './node_modules/*'); do node --check "$f"; done` | exit 0 |

No build step, no typecheck, no lint — the plugin is plain ES module JS.

## Test structure

- **Test runner**: `node:test` (built-in Node.js test framework)
- **Test files**: `test/*.test.js` — 23 test files covering all modules
- **Helpers**: `test/helpers/fake-api.js` — reusable fake OpenClaw API objects
- **Fixtures**: `test/fixtures/decide-scenarios.json` — 20+ labeled decide scenarios
- **Parity matrix**: `test/parity-matrix.mjs` — 35 behavioral checks, must stay covered on every change
- **Pattern**: Each lib module has a corresponding test file (`lib/gate.js` → `test/gate.test.js`)
