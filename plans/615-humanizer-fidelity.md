# Plan 615: Humanizer fidelity — split the draft, never rewrite it

> **Executor instructions**: Follow step by step; run every verification. If a
> STOP condition occurs, stop and report. Commit in the worktree. Skip the
> `plans/README.md` update (reviewer maintains the index).

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: LOW–MED (alters group bubble delivery; falls back to content-preserving split)
- **Depends on**: none (works on the current branch `advisor/613-initiative-engine`)
- **Category**: bug
- **Planned at**: commit `90bdc6a`, 2026-09-10

## Why this matters

Live evidence: the agent's raw reply (Web-UI/LCM) is correct, but the WhatsApp
bubbles are not. Example — raw draft `lib`/LCM message: *"… Ich schau heut Abend
rein, wenn's **bei dir** ruhig ist. 👍"*; the delivered bubble became *"… wenn
**bei mir** Ruhe ist."* Another: raw *"Tja, Selbstbewusstsein auf Deutsch, Dativ
aus Übersee — der Mix macht's. … Bei „dir/mir" verliert halt auch das beste
Modell mal ein paar Punkte…"* was delivered as a different sentence *"Für
jemandem, der angeblich keine Deutsch-Grammatik kann, bist du erstaunlich gut…"*.

Cause: `lib/local-engine.js:150-215` `respond()` sends the whole draft to the
split LLM (`buildSplitPrompt`, temperature `0.9`) and accepts the returned
`messages` with only length/count checks (`:188-192`) — **no faithfulness
check**. The model paraphrases, flips pronouns (`dir`↔`mir`), and changes
meaning. Fix: instruct split-only, lower temperature, and add a deterministic
faithfulness guard that falls back to the existing content-preserving mechanical
splitter when the LLM drifts.

## Current state (exact anchors)

- `lib/local-engine.js:162` builds the split prompt; `:170` uses
  `cfg?.humanize?.temperature ?? 0.9`; `:188-208` accepts parsed bubbles with no
  drift check; `:210/:213` fall back to `[{ content: draft }]` on parse/LLM error.
- `lib/local-prompts.js:341-390` `buildSplitPrompt` — current guidance includes
  `"Split the reply into 1–5 chat messages the way a person fragments a thought.
  1–2 short sentences each. First may be a pure reaction."` and a long anti-tell
  block. It does NOT forbid paraphrase/pronoun changes.
- `lib/naturalize.js:453-534` — the flush already has a mechanical,
  content-preserving fallback: `fragmentDraft(text, maxBubbles)` (defined
  `lib/naturalize.js:44-72`) split into sentences and scheduled; triggered today
  only when numeric facts are missing from the bubbles (`:473-534`).
- Config defaults: `lib/config.js:43-46` `humanize = { maxBubbles: 5,
  temperature: 0.9 }`; schema `openclaw.plugin.json` `humanize` block.

## Scope

**In scope (modify ONLY these):**
- `lib/anti-tell.js` — add `isFaithfulSplit(draft, bubbles)` (pure, exported)
- `lib/local-prompts.js` — strengthen `buildSplitPrompt` fidelity rules
- `lib/naturalize.js` — faithfulness guard in `flush` → reuse the mechanical fragment fallback
- `lib/config.js` + `openclaw.plugin.json` — `humanize.temperature` default `0.9`→`0.3`; add `humanize.requireFaithfulSplit` (bool, default `true`)
- `test/anti-tell.test.js`, `test/naturalize.test.js`, `test/local-prompts.test.js`
- `test/e2e-local.test.js` — its fake `engine.respond` fixtures must emit
  FAITHFUL splits (bubbles that are verbatim substrings of the draft) so the
  delivery/timing/epoch tests keep exercising the default guard path
- `test/parity-matrix.mjs` — one new row (88)

**Out of scope:** changing the decide/gate paths; changing `fragmentDraft`
semantics; any live config flip; real names/numbers/JIDs.

## Steps

### Step 1: `isFaithfulSplit(draft, bubbles)` in `lib/anti-tell.js`

Pure, never throws. Normalize with lowercase + `String.normalize("NFKC")` +
replace every non-letter/non-digit (Unicode `\p{L}\p{N}`) run with a single
space + trim. `draftNorm = norm(draft)`. For each bubble (`string` or
`{content}`), `bn = norm(bubble)`; if `bn` is non-empty and
`!draftNorm.includes(bn)` → return `false`. Return `true` otherwise (a pure-emoji
or empty bubble normalizes to "" and is ignored). This catches pronoun flips
(`bei dir`→`bei mir`), added reaction words, and invented sentences.

**Verify**: `node --input-type=module -e 'import { isFaithfulSplit } from "./lib/anti-tell.js"; console.log(isFaithfulSplit("Ich schau rein, wenn bei dir Ruhe ist.", ["Ich schau rein,","wenn bei dir Ruhe ist."]), isFaithfulSplit("Ich schau rein, wenn bei dir Ruhe ist.", ["wenn bei mir Ruhe ist."]))'` → `true false`.

### Step 2: strengthen `buildSplitPrompt` (`lib/local-prompts.js`)

Add HARD rules to the anti-tell block in `buildSplitPrompt` (keep the existing
lines):
- `"Use ONLY the draft's exact words. You may split it at natural sentence boundaries and fix punctuation/capitalization — nothing else."`
- `"NEVER paraphrase, translate, reword, add, remove, or reorder content. Never change pronouns (ich/du/dir/mir/er/sie) or names."`
- `"Do NOT invent a reaction or filler bubble that is not present in the draft."`
- Replace the permissive line `"First may be a pure reaction."` with a version
  that only allows a reaction if the draft already contains it.
- Keep the JSON contract line.

**Verify**: `node --test test/local-prompts.test.js` → all pass; add/keep a test
asserting the split prompt contains `"Use ONLY the draft's exact words"` and
never reintroduces unrestricted reaction invention.

### Step 3: guard in `lib/naturalize.js` `flush`

Import `isFaithfulSplit` from `./anti-tell.js`. After `scheduled` is computed
(around `:453-465`) and before delivery, compute:
```js
const unfaithful = cfg?.humanize?.requireFaithfulSplit !== false
  && engine && scheduled.length > 0
  && !isFaithfulSplit(finalDraft, scheduled);
```
When `unfaithful` is true, log `human-engine: humanize unfaithful — mechanical split sk=…` and route through the SAME content-preserving mechanical fallback the numeric fact-guard already uses: `fragmentDraft(finalDraft, cfg?.humanize?.maxBubbles ?? 5)` scheduled via `_scheduleBubbles` and delivered. Generalize the existing block at `:473-534` rather than duplicating it (e.g. compute `const needsMechanical = unfaithful || (draftTokens.length >= 2 && missing.length > draftTokens.length/2);` and run the fragment scheduling once). Keep the `![parse/LLM error]` behavior intact. Do NOT run the guard on the raw-fallback path.

**Verify**: `node --test test/naturalize.test.js` → all pass.

### Step 4: config + schema

- `lib/config.js`: `humanize.temperature: 0.3`, add `humanize.requireFaithfulSplit: true`.
- `openclaw.plugin.json`: same two keys in the `humanize` schema (defaults).

**Verify**: `node --test test/config.test.js` → all pass.

### Step 5: tests

- `test/anti-tell.test.js`: `isFaithfulSplit` — faithful split true; pronoun flip false; invented reaction false; punctuation/casing change true; emoji-only bubble ignored true; reordered bubbles false; non-string input safe.
- `test/naturalize.test.js`: `flush` integration — a fake `engine.respond` returns a paraphrased bubble (e.g. draft `"… wenn bei dir Ruhe ist."` → bubble `"wenn bei mir Ruhe ist."`); assert the DELIVERED content is the mechanical fragment of the draft (contains `"bei dir"`, not `"bei mir"`), and the unfaithful warn fired. Also assert faithful bubbles pass through unchanged.
- `test/parity-matrix.mjs`: add row 88 `"humanize is faithful: LLM split is guarded — paraphrased/pronoun-flipped bubbles fall back to the content-preserving mechanical split"` with a tag matching a new naturalize/anti-tell test name (e.g. `"humanize unfaithful"` or `"isFaithfulSplit"`). Then `--check` must show 88/88.
- `test/e2e-local.test.js`: keep the guard ON (do NOT disable it) — update the
  fake `engine.respond` fixtures so the returned bubbles are faithful. E.g. the
  draft `"This is the draft reply"` + bubbles `"First bubble"`/`"Second
  bubble"`/`"Third bubble"` becomes a draft that CONTAINS those bubbles verbatim
  (e.g. draft `"First bubble. Second bubble. Third bubble."`), preserving the
  test's intent (3 deliveries, order, epoch cancellation). Apply the same to the
  epoch-bump fixture. Do NOT set `requireFaithfulSplit:false` here.

### Step 6: full gate + commit

- `npm test` → 0 fail; `node test/parity-matrix.mjs --check` → 88/88, exit 0.
- Commit: `fix(humanize): faithful split guard + fidelity prompt (plan 615)`.

## Done criteria

- [ ] `npm test` exits 0; parity 88/88
- [ ] `isFaithfulSplit` returns false for a pronoun-flipped bubble
- [ ] the naturalize flush delivers the mechanical draft fragment when the LLM split drifts
- [ ] `humanize.temperature` default is `0.3`; `humanize.requireFaithfulSplit` defaults `true`
- [ ] `git status` shows only in-scope files (+ node_modules symlink)

## STOP conditions

- The existing fact-guard fallback block cannot be generalized without touching
  out-of-scope files or changing its numeric-fact semantics — report instead.
- A test outside the in-scope list must change to pass.
- The guard would reject a legitimately faithful split in more than the
  punctuation/casing case (report the case; do not loosen silently).
