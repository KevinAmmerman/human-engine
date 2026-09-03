# Build, test, lint

All commands verified during wiki refresh. Run from the project root.

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `npm install` | exit 0 |
| Test | `npm test` | 656 pass, 0 fail |
| Parity matrix | `node test/parity-matrix.mjs --check` | `40/40 covered` |
| E2E test | `node test/e2e-local.test.js` | exit 0 |
| Syntax check | `node --check index.js && for f in $(find . -name '*.js' -not -path './node_modules/*'); do node --check "$f"; done` | exit 0 |
| Schema JSON | `python3 -m json.tool < openclaw.plugin.json > /dev/null` | exit 0 |

No build step, no typecheck, no lint — the plugin is plain ES module JS.

## Test structure

- **Test runner**: `node:test` (built-in Node.js test framework)
- **Test files**: `test/*.test.js` — 29 test files covering all modules
- **Helpers**: `test/helpers/sdk-hook-ctx.js` (335's hook-context factory) +
  inline fakes per file; `test/helpers/ensure-plugin-sdk-shim.mjs`
- **Fixtures**: `test/fixtures/decide-scenarios.json` — 20+ labeled decide scenarios
- **Parity matrix**: `test/parity-matrix.mjs` — 40 behavioral checks, must stay covered on every change
- **Pattern**: Each lib module has a corresponding test file (`lib/gate.js` → `test/gate.test.js`); hook contracts live in `test/hook-contract.test.js`
