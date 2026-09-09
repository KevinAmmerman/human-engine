# Plan 015: Version-Sync + Dead-Code openThread — Versions­­drift schließen, No-OP-Stub entfernen

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git -C ~/human-engine diff --stat c4e148b..HEAD -- package.json openclaw.plugin.json lib/local-engine.js test/gate.test.js test/harness.test.js`
> On mismatch with the "Current state" excerpts: STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (Metadaten + Entfernen eines ungenutzten Stubs)
- **Depends on**: none
- **Category**: dx / tech-debt
- **Planned at**: commit `c4e148b`, 2026-09-09

## Why this matters

CHANGELOG.md dokumentiert 0.4.2 (group bubble TTS, Plan 548b), aber
package.json + openclaw.plugin.json sagen 0.4.1 und package-lock.json
root 0.4.0 — Wiki/Agent/Consumer melden die falsche Version. Zusätzlich ist
`openThread(sessionKey)` in local-engine.js ein No-OP-Stub
(`return { id: sessionKey }`) mit null Produktions-Callern — er sieht aus
wie eine Thread-API (der Plan-031-Self-Voice/Thread-Reader wird darauf
hereinfallen), tut aber nichts.

## Current state

- `package.json:3` → `"version": "0.4.1"`; `openclaw.plugin.json:4` →
  `"version": "0.4.1"`; `package-lock.json` root → `"version": "0.4.0"`.
- `CHANGELOG.md:3` → `## 0.4.2 — group bubble TTS (plan 548b)`.
- `lib/local-engine.js:35-37`:
  ```js
  function openThread(sessionKey) {
    return { id: sessionKey };
  }
  ```
  Exportiert im Return (Z. ~257: `return { openThread, decide, ... }`).
  Produktions-Caller: keine (nur Fake-Stubs in `test/gate.test.js` ~Z. 24 und
  `test/harness.test.js` ~Z. 15, die eigene openThread-Fakes definieren —
  keine echten Abhängigkeiten).

BEWUSST NICHT anfassen (spätere Pläne brauchen sie): `detectTells` in
anti-tell.js (Plan 027 wired es in den Runtime-Pfad), und
`buildMemoryExtractPromptV2` in local-prompts.js (Plan 020 wired es).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Tests | `npm test` | all pass, 0 fail |
| Parity | `node test/parity-matrix.mjs --check` | fully covered, exit 0 |
| Version | `node -e "…assert script (Step 3)"` | exit 0 |

## Scope

**In scope**:
- `package.json`, `openclaw.plugin.json`, `package-lock.json` (root version)
- `lib/local-engine.js` (nur openThread entfernen)
- `test/gate.test.js`, `test/harness.test.js` (nur openThread-Fake-Stubs)
- `test/version-sync.test.js` (NEU)

**Out of scope**:
- `lib/anti-tell.js` (detectTells bleibt!), `lib/local-prompts.js`
  (buildMemoryExtractPromptV2 bleibt!)
- CHANGELOG-Einträge schreiben (0.4.2 existiert bereits; diese Welle
  changelogged der Operator beim Release)
- Irgendein Behavior-Change

## Git workflow

- Branch: `advisor/015-version-sync-deadcode`
- 2 Commits; Stil `plan 015: …`

## Steps

### Step 1: Versionen synchronisieren

1. `package.json` + `openclaw.plugin.json` → `"version": "0.4.2"`.
2. `package-lock.json`: root `"version": "0.4.2"` (die zwei Root-Vorkommen
   im JSON — packages[""]-Sektion und top-level).

**Verify**: `grep -n '"version"' package.json openclaw.plugin.json | grep 0.4.2` → 2 Treffer.

### Step 2: openThread entfernen

1. `lib/local-engine.js`: Funktions-Definition UND den Eintrag im
   return-Objekt entfernen.
2. `test/gate.test.js`/`test/harness.test.js`: openThread-Fake-Stubs in
   Engine-Fakes entfernen (nur wo der Fake es explizit listet; wenn der Test
   es nicht referenziert, nichts tun).

**Verify**: `rg -n "openThread" lib/ test/` → keine Treffer. `npm test` → all pass.

### Step 3: Version-Drift-Regressionstest

Neu `test/version-sync.test.js` (node:test, kein fs-Extra — node:fs reicht):

```js
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

test("version sync: package.json, plugin manifest and changelog head agree", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
  const changelogHead = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8")
    .split(/^## /m)[1].split(" ")[0]; // erste Version nach "## "
  assert.equal(pkg.version, manifest.version);
  assert.equal(pkg.version, changelogHead);
});
```

(CHANGELOG-Header-Format prüfen: `## 0.4.2 — …` → Split-Pfad ggf. anpassen,
sodass `0.4.2` extrahiert wird; der Test muss robust gegen das reale
Format sein — im Zweifel `/^## (\d+\.\d+\.\d+)/m`-Regex.)

**Verify**: `node --test test/version-sync.test.js` → pass; `npm test` →
all pass; Parity fully covered.

## Test plan

Siehe Step 3. Kein bestehender Test darf sich ändern (openThread-Fakes
ausgenommen).

## Done criteria

- [ ] `rg -n "openThread" lib/ test/` → leer
- [ ] `rg -n '"version": "0.4' package.json openclaw.plugin.json` → nur `0.4.2`
- [ ] `npm test` exit 0 inkl. version-sync; Parity fully covered
- [ ] `plans/README.md` Status-Row aktualisiert

## STOP conditions

- Ein Test bricht, weil er openThread tatsächlich funktional nutzt
  (nicht nur als Fake-Feld) → STOP, Report.
- CHANGELOG-Head-Parsing ist mehrdeutig (mehrere `## `-Formate) → Test
  konkret an das reale Format binden; wenn unstabil, Report statt Regex-Improvisation.

## Maintenance notes

- Der version-sync-Test zwingt künftige Wellen zum Version-Bump mit dem
  CHANGELOG-Eintrag — Releasewartung einfacher.
- Wenn Plan 022 (Thread-State) landet, KANN eine echte `openThread`-artige
  API entstehen — dann bewusst neu designen, nicht den alten Stub
  „wiederbeleben".
