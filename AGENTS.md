# human-engine — agent guide

Human Engine is an OpenClaw plugin that makes the agent behave more like a
human in group chats and DMs: turn-taking (speak/stay-silent decisions),
bubble naturalization (splitting + timing replies), a learned voice card,
social memory, proactive turn-taking, and DM-proactive rendering. It runs
in-process in the OpenClaw gateway and shares its LLM instance.

## Verification

- Tests: `npm test` — node:test suite, all must pass (656 pass / 0 fail as of
  this doc; update this line only when it changes structurally).
- Parity matrix: `node test/parity-matrix.mjs --check` — release contract,
  must be fully covered (40/40).
- No build, lint, or typecheck — the plugin is plain ES modules on Node 24+.

## Architecture

See `wiki/architecture/overview.md`. In short: `index.js` registers typed hook
handlers; `lib/gate.js` decides speak/stay-silent via the local engine;
`lib/naturalize.js` splits and times replies; `lib/proactive.js` is the
3-stage proactive funnel; `lib/dm-proactive.js` renders due-DM commitments
shadow-first. Config schema lives in `openclaw.plugin.json`.

## Config merge semantics

Config resolves with a one-level deep merge from the OpenClaw API over the
defaults in `lib/config.js` (nested keys: `socialLearning`, `socialMemory`,
`decide`, `humanize`, `timing`, `naturalize`, `proactive`, `dmProactive`).
A partial override never drops sibling defaults. The schema in
`openclaw.plugin.json` is strict — keep it in sync with `lib/config.js`.

## Conventions

- Log prefix: `human-engine:`
- `wrap()` never throws into the hook chain — hook errors fail open for DMs,
  fail closed for group gate errors.
- State lives in `state/` with 0600/0700 permissions (request logs, session
  keys redacted on write).
- This repo is PUBLIC — never commit real contact data, phone numbers, names,
  or session keys. Use obviously-fake values in fixtures/comments.

## Test structure

- Runner: `node:test` with inline fakes.
- Shared hook-context factory: `test/helpers/sdk-hook-ctx.js`.
- Parity matrix (`test/parity-matrix.mjs`) is the release contract — every
  behavioral row must stay covered on every change.
