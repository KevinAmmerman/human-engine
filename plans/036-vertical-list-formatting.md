# Plan 036: Render inline pipe-separated lists vertically (bubble delivery)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat ad34c15..HEAD -- lib/anti-tell.js lib/naturalize.js test/anti-tell.test.js test/parity-matrix.mjs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `ad34c15`, 2026-09-10

## Why this matters

A live WhatsApp group message enshrined a schedule as one horizontal line:
`Mo 14.09. | 2. Di 15.09. | 3. Mi 16.09. | ...` instead of one item per line.
The model is instructed (rightly) not to emit markdown lists, so it crams an
enumeration onto a single line using ` | ` as a separator; the tell sanitizer
then strips the first `1.` and leaves the rest tangled. The result is hard to
read on a phone — exactly the format a group uses to vote on a date. After this
plan, an inline pipe enumeration becomes one item per line (numbers preserved),
so schedules and tallies render the way a human would type them.

## Current state

The pipeline at flush time: capture raw model text → `stripMetaCommentary` →
`sanitizeTells` → humanize/split (`engine.respond`) → per-bubble
`sanitizeTells` → deliver.

- `lib/anti-tell.js:69-81` — `sanitizeTells`; bold stripped first in `out`
  (line 74), but `detectTells` runs on the ORIGINAL text; line 78 strips
  bullet AND numbered markers:
  ```js
  export function sanitizeTells(text) {
    if (typeof text !== "string" || !text) return { text, tells: [] };
    const tells = detectTells(text);
    let out = text;
    if (tells.includes("em-dash")) out = out.replace(/\u2014/g, ", ");
    if (tells.includes("bold-markdown")) out = out.replace(/\*\*/g, "");
    if (tells.includes("header")) out = out.replace(/^#+\s*/gm, "");
    if (tells.includes("certainly-exclamation")) out = out.replace(/^Certainly!\s*/gim, "");
    if (tells.includes("customer-service")) out = out.replace(/How can I help you\?/gi, "");
    if (tells.includes("list")) out = out.replace(/^\s*[-*+]\s+/gm, "").replace(/^\s*\d+[.)]\s+/gm, "");
    out = out.replace(/[ \t]{2,}/g, " ").trim();
    return { text: out, tells };
  }
  ```
  Because `detectTells` sees `**1.** Mo …` (leading `*`, not a digit), the
  "list" tell is NOT detected on the first pass; line 74 strips the bold, and
  a later pass strips the now line-leading `1.` only. Net delivered text:
  `Mo 14.09. | 2. Di 15.09. | ...` — horizontal, first number lost.
- `lib/naturalize.js:3` — `import { stripMetaCommentary, sanitizeTells } from "./anti-tell.js";`
- `lib/naturalize.js:366` — `const draft = parts.join("\n").trim();`
- `lib/naturalize.js:372` — `const cleaned = stripMetaCommentary(draft, memberNames);`
- `lib/naturalize.js:376` — `let finalDraft = cleaned.text;`
- `lib/naturalize.js:416` — `const san = sanitizeTells(finalDraft);` (draft sanitize)
- `lib/naturalize.js:453-460` — per-bubble pass:
  ```js
  const scheduled = (respondResult.scheduled || [])
    .map((bubble) => {
      const b = sanitizeTells(bubble.content);
      if (b.tells.length > 0) _log.warn(`human-engine: tells-sanitized bubble kinds=${b.tells.join(",")}`);
      bubble.content = b.text;
      return bubble;
    })
  ```
- `test/anti-tell.test.js:116-120` — existing sanitize test for bullets:
  ```js
  it("converts bullet/numbered lists to plain lines", () => {
    const r = sanitizeTells("- item one\n- item two");
    assert.ok(r.tells.includes("list"));
    assert.equal(r.text, "item one\nitem two");
  });
  ```
  Note this test only feeds BULLETS. The `it` name is misleading; it is safe to
  keep the name (parity row 68 matches on it) but the behavior for NUMBERED
  lines changes.
- `test/parity-matrix.mjs:141` — row 68. The parity checker only requires ONE
  `tags` entry to substring-match a test name (`test/parity-matrix.mjs:195-235`).

Repo conventions: plain ES modules, `node:test` with inline assertions, no
build/lint/typecheck. Match `test/anti-tell.test.js` style. Log prefix
`human-engine:`. This repo is PUBLIC — no real names/numbers/session keys in
code, tests, comments, or fixtures.

## Commands you will need

| Purpose   | Command                              | Expected on success |
|-----------|--------------------------------------|---------------------|
| Tests     | `cd ~/human-engine && npm test`      | all pass, 0 fail    |
| Parity    | `node test/parity-matrix.mjs --check` | fully covered, exit 0 |
| Focused   | `node --test test/anti-tell.test.js` | all pass            |

## Scope

**In scope** (the only files you should modify):
- `lib/anti-tell.js` — add `expandInlineLists`, adjust the numbered-marker line
- `lib/naturalize.js` — import + call `expandInlineLists` at the two call sites
- `test/anti-tell.test.js` — new tests
- `test/parity-matrix.mjs` — update row 68 behavior string (+ one tag)

**Out of scope** (do NOT touch, even though they look related):
- Markdown TABLE rendering (`Lib…`, `| Wer | Nummer | Notiz |`). Tables are a
  separate concern (see Maintenance notes). Do not add table handling here.
- `detectTells` semantics (keep flagging `list`).
- Any prompt/persona file, any dependency, any state file.

## Git workflow

- Branch: `advisor/036-vertical-list-formatting` (match existing advisor branches).
- Commit messages: match `git log` style, e.g.
  `fix(naturalize): render inline pipe lists vertically (advisor 036)`.
- Do NOT push or open a PR.

## Steps

### Step 1: Add `expandInlineLists` to `lib/anti-tell.js`

Add this exported helper next to `sanitizeTells`. It transforms only lines that
look like an inline enumeration; everything else passes through byte-identical.

```js
// A single line whose items are joined with " | " is how a model evades the
// "no markdown lists" rule. Expand such a line to one item per line so the
// delivery renders vertically. Only lines that are clearly list-like are
// touched; prose with one pipe and markdown table rows are left alone.
const ENUM_ITEM_RE = /^\s*(?:\*\*)?\d+[.)](?:\*\*)?\s+/;

export function expandInlineLists(text) {
  if (typeof text !== "string" || !text.includes("|")) return text;
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      // Leave markdown table rows (header/body/separator) untouched.
      if (trimmed.startsWith("|")) return line;
      const segments = line.split("|").map((s) => s.trim());
      const allEnumerated = segments.length >= 2 && segments.every((s) => ENUM_ITEM_RE.test(s));
      const manySegments = segments.length >= 3;
      if (!allEnumerated && !manySegments) return line;
      return segments
        .map((s) => s.replace(/^\s*\*\*(\d+)[.)]\*\*\s+/, "$1. ").replace(/^\s*(\d+)[.)]\s+/, "$1. "))
        .filter((s) => s.length > 0)
        .join("\n");
    })
    .join("\n");
}
```

Notes for the executor:
- `allEnumerated` handles `1. A | 2. B` (2 segments, both numbered).
- `manySegments` handles `A | B | C` (3+ segments) even without numbers.
- Only the enumerator's own `**` is removed; other bold is left for
  `sanitizeTells` to strip, so this function has no opinion on formatting.
- Do not add comments beyond the block above unless the repo style requires it.

**Verify**: `node --input-type=module -e 'import { expandInlineLists } from "./lib/anti-tell.js"; console.log(JSON.stringify(expandInlineLists("**1.** Mo | **2.** Di")))'`
→ prints `"1. Mo\n2. Di"`.

### Step 2: Preserve numbered markers in `sanitizeTells`

Change the single list line (currently `lib/anti-tell.js:78`) from:

```js
if (tells.includes("list")) out = out.replace(/^\s*[-*+]\s+/gm, "").replace(/^\s*\d+[.)]\s+/gm, "");
```

to:

```js
if (tells.includes("list")) out = out.replace(/^\s*[-*+]\s+/gm, "");
```

Rationale: bullets stay a "tell" and are stripped; a numbered enumeration is
legitimate structure (the slot list is referenced by number elsewhere in the
same message). `detectTells` is unchanged, so the `tells` report still shows
`list` and the warning log still fires.

**Verify**: `node --input-type=module -e 'import { sanitizeTells } from "./lib/anti-tell.js"; console.log(JSON.stringify(sanitizeTells("1. first\n2. second")))'`
→ `{"text":"1. first\n2. second","tells":["list"]}`.

### Step 3: Wire `expandInlineLists` into `lib/naturalize.js`

1. Line 3 import becomes:
   ```js
   import { stripMetaCommentary, sanitizeTells, expandInlineLists } from "./anti-tell.js";
   ```
2. Before the draft sanitize (currently line 416), insert:
   ```js
   finalDraft = expandInlineLists(finalDraft);
   const san = sanitizeTells(finalDraft);
   ```
3. In the per-bubble map (currently lines 453-460), expand before sanitize:
   ```js
   .map((bubble) => {
     const expanded = expandInlineLists(bubble.content);
     const b = sanitizeTells(expanded);
     if (b.tells.length > 0) _log.warn(`human-engine: tells-sanitized bubble kinds=${b.tells.join(",")}`);
     bubble.content = b.text;
     return bubble;
   })
   ```

Why both places: the draft expansion gives the raw-fallback path and the
humanize model vertical input; the per-bubble expansion catches the humanize
model re-collapsing the list onto one line.

**Verify**: `node --test test/naturalize.test.js` → all pass (no test yet asserts
the new behavior; this confirms no regression).

### Step 4: Tests in `test/anti-tell.test.js`

Add a `describe("expandInlineLists")` block after the `sanitizeTells` block, and
add one test to the `sanitizeTells (plan 027)` block:

- `"expands a bold numbered pipe list into vertical numbered lines"`:
  input `"**1.** Mo | **2.** Di | **3.** Mi"` → `"1. Mo\n2. Di\n3. Mi"`.
- `"expands a plain numbered pipe list"`:
  input `"1. A | 2. B"` → `"1. A\n2. B"`.
- `"expands a 3+ segment non-enumerated pipe line"`:
  input `"A | B | C"` → `"A\nB\nC"`.
- `"leaves a two-segment non-enumerated line unchanged"`:
  input `"left | right"` → unchanged.
- `"leaves a markdown table row unchanged"`:
  input `"| Wer | Nummer |"` → unchanged.
- `"leaves prose with no pipe unchanged"` and `"passes non-string through"`.
- In the existing `sanitizeTells` block: `"preserves numbered list markers"`:
  `sanitizeTells("1. first\n2. second").text === "1. first\n2. second"` and
  tells include `"list"`.

Model the structure on the existing tests in the file (same imports, same
`assert` style).

**Verify**: `node --test test/anti-tell.test.js` → all pass, including the new ones.

### Step 5: Parity row 68

In `test/parity-matrix.mjs`, update row 68's `behavior` string to mention that
numbered schedule lines are preserved. Example:

```
behavior: "mechanical tells (em-dash/markdown/bullets/headers) are sanitized at flush + per-bubble with fail-open semantics; inline pipe enumerations are expanded vertically; numbered schedule lines are preserved; semantic tells are logged only",
```

Add one tag matching the Step-4 test name, e.g.
`"expands a plain numbered pipe list"` to the row's `tags` array. Leave the
existing tags (the em-dash/bold/header tests still satisfy them).

**Verify**: `node test/parity-matrix.mjs --check` → line starts with
`Parity matrix:` and reports full coverage with no `[NOT FOUND]`, exit 0.

### Step 6: Full gate

**Verify**: `cd ~/human-engine && npm test` → all pass, 0 fail.
**Verify**: `node test/parity-matrix.mjs --check` → fully covered, exit 0.

## Test plan

- New tests: the 7 `expandInlineLists` cases + the `sanitizeTells` numbered
  preservation test, in `test/anti-tell.test.js`.
- Structural pattern: existing `describe("sanitizeTells (plan 027)")` block in
  the same file.
- Regression guard: the two live-shaped inputs
  `"**1.** Mo 14.09. | **2.** Di 15.09. | **3.** Mi 16.09."` →
  `"1. Mo 14.09.\n2. Di 15.09.\n3. Mi 16.09."` and the full draft variant that
  also contains `"(Alle abends, Di/Do eher ab 20:00.)"` on its own line.
- Verification: `npm test` → all pass; `node test/parity-matrix.mjs --check` → covered.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cd ~/human-engine && npm test` exits 0 with 0 failures
- [ ] `node test/parity-matrix.mjs --check` exits 0, no `[NOT FOUND]`
- [ ] `grep -n "expandInlineLists" lib/anti-tell.js lib/naturalize.js` shows the export + import + two call sites
- [ ] `grep -n "\^\\\\s\*\\\\d+\[.)\]" lib/anti-tell.js` returns no match (numbered strip removed)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The line numbers/excerpts in "Current state" do not match the live files.
- `npm test` or parity fails twice after a reasonable fix attempt.
- Fixing this appears to require touching table rendering, prompts, or any
  out-of-scope file.
- You find that `expandInlineLists` changes a message that does NOT contain a
  list-like pipe enumeration (that would be a bug — report it).

## Maintenance notes

- Reviewers: the intended trade-off is that numbered enumerations are now
  allowed through; bullets remain banned. If AI-ish numbered-list spam ever
  appears in groups, the lever is this function/line — tighten `manySegments`
  or reintroduce a targeted numbered strip for non-enumeration content.
- Markdown TABLES are still delivered as raw pipes (pre-existing, out of
  scope). If a follow-up wants vertical contact tables, add table-to-text
  normalization as a separate plan and extend `sanitizeTells`, not this helper.
- The humanize/split model can still re-collapse a list; the per-bubble
  expansion in `naturalize.js` is the backstop. If a future refactor removes
  the per-bubble sanitize block, this protection is lost.
- Interaction with the fact-guard fallback (`naturalize.js` fragment path):
  it consumes `finalDraft`, which is already expanded, so numeric facts stay
  on their own lines and the fragmenter keeps them.
