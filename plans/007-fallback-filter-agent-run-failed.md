# Plan 007: System-Fallback-Filter schließen — „⚠️ Agent run failed (model: …)" darf nie als Reply captured werden

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git -C ~/human-engine diff --stat 1e11ffe..HEAD -- lib/naturalize.js test/`
> On mismatch with the "Current state" excerpt: STOP condition.

## Status

- **Priority**: P1 (Prod-Incident 2026-09-09 ~15:15 UTC, Gruppe „Diskussion runde & News")
- **Effort**: S
- **Risk**: LOW (Filter wird strikt erweitert; legitime Replies können den Patterns nicht entsprechen)
- **Depends on**: none (baut auf der gemergten Welle 001–006 auf)
- **Category**: bug
- **Planned at**: commit `1e11ffe`, 2026-09-09

## Why this matters

Live-Incident: Ein Agent-Run scheiterte (Host-Fehler „Session transcript keyed
user is outside the current turn", Modell crof/deepseek-v4-flash als aktiver
Fallback). Der Host lieferte daraufhin den Fallback-Text
`⚠️ Agent run failed (model: crof/deepseek-v4-flash-0731).` als Reply-Payload.
`isSystemFallbackText` (Plan 540) kennt nur ZWEI Fallback-Texte
(NO_VISIBLE_REPLY / QUEUE_CAP) — der dritte wurde als echte Antwort captured,
von der Humanize-LLM bei temperature 0.9 unter Verwendung des
Keynote-Transcripts in einen plausiblen Satz umgeschrieben und mit 30 s Delay
an die Gruppe zugestellt. Ergebnis aus Nutzersicht: „zeitversetzt dieselbe
Antwort" (Fehler-Bubble + echte Antwort 90 s später). Dieser Plan schließt
die Filter-Lücke — der Fehlertext muss NIE wieder in die Bubble-Pipeline
geraten, egal welcher Wortlaut vom Host kommt.

## Current state

`lib/naturalize.js:104-112` (bei `1e11ffe`):

```js
function isSystemFallbackText(text) {
  if (typeof text !== "string") return false;
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return false;
  const fallback = NO_VISIBLE_REPLY_FALLBACK_TEXT.replace(/\s+/g, " ").trim().toLowerCase();
  const queueCap = QUEUE_CAP_REJECTION_TEXT.replace(/\s+/g, " ").trim().toLowerCase();
  return normalized.includes(fallback) || normalized.includes(queueCap);
}
```

Konstanten (Z. 18-19): `NO_VISIBLE_REPLY_FALLBACK_TEXT = "No reply was
generated for this message. …"`, `QUEUE_CAP_REJECTION_TEXT = "This message
was not queued …"`. Aufrufstelle: `onReplyPayloadSending` capture-Pfad
(`isSystemFallbackText(text)` → cancel, nie captured).

Der geleakte Text (Live-Beweis, Gateway-Log 15:15:24 UTC, observed-store):
`⚠️ Agent run failed (model: crof/deepseek-v4-flash-0731).`
Struktur: beginnt mit `⚠️`, enthält `agent run failed (model:` +.provider
+ `/` + Modellname + `)` + optional `.`.

Konventionen: Log-Präfix `human-engine:`; Tests node:test inline fakes
(`test/naturalize.test.js` hat die Plan-540-Fallback-Filter-Cases als
Muster — grep „system fallback"); Parity `test/parity-matrix.mjs` Row 43
(„System fallback payloads suppressed in capture") ist der Vertragsanker.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Tests | `npm test` (in worktree) | all pass, 0 fail |
| Parity | `node test/parity-matrix.mjs --check` | `56/56 covered`, exit 0 |
| Unit | `node --test test/naturalize.test.js` | all pass |

## Scope

**In scope**:
- `lib/naturalize.js` (nur isSystemFallbackText + ggf. Konstante)
- `test/naturalize.test.js` (neue Cases)
- `test/e2e-local.test.js` (ein Regressions-Case)
- `test/parity-matrix.mjs` (eine neue Row)

**Out of scope**:
- `lib/local-engine.js`, Session-Transcript-Interplay (der zugrundeliegende
  Run-Fehler „Session transcript keyed user is outside the current turn"
  ist HOST-seitig — separater Bericht an den Operator, hier NICHT behandelbar)
- Alle anderen Module

## Git workflow

- Branch: `advisor/007-fallback-filter` (Worktree, gestapelt auf main)
- Ein bis zwei Commits; Stil `plan 007: …`. PUBLIC repo.

## Steps

### Step 1: Filter erweitern

1. Neue Konstante neben den bestehenden beiden:
   ```js
   const AGENT_RUN_FAILED_RE = /^⚠️\s*agent run failed\b/i;
   ```
2. In `isSystemFallbackText` zusätzlich:
   ```js
   return normalized.includes(fallback) || normalized.includes(queueCap) || AGENT_RUN_FAILED_RE.test(normalized);
   ```
   Bewusst: Anchored-Prefix-Match (`^⚠️ agent run failed`) statt freiem
   `includes("agent run failed")` — ein Mitglied, das wörtlich „agent run
   failed" tippt, soll weiterhin normal behandelt werden; das ⚠️-Präfix
   kommt nur vom Host-Fallback. Der normalized-Text beginnt nach
   trim+collapse mit „⚠️ agent run failed (model: …)".

**Verify**: `node --test test/naturalize.test.js` → pass (neue Cases
Step 3).

### Step 2: Tests

1. `test/naturalize.test.js` (Muster: bestehende Plan-540-Fallback-Cases):
   - exakter Incident-Text „⚠️ Agent run failed (model: crof/deepseek-v4-flash-0731)." → captured=false / cancel=true, NIE in der Bubble-Pipeline;
   - Varianten: anderes Modell (`gmx/glm-5.3-flash`), ohne Punkt, mit führenden Leerzeichen;
   - NEGATIV: „I had an agent run failed moment, funny story" (kein ⚠️-Präfix) → KEIN cancel;
   - NEGATIV: normale Antwort → kein cancel (Bestehendes bleibt).
2. `test/e2e-local.test.js`: Regressions-Case im bestehenden Stil —
   speak-Turn, reply_payload mit dem Incident-Text → Payload gecancelt,
   KEIN dispatcher.sendBlockReply mit dem Fehlertext, eigener
   observed-Eintrag für den Fallback NICHT nötig (Plan-540-Semantik:
   cancel + verwerfen).
3. `test/parity-matrix.mjs`: neue Row 56:
   ```js
   { id: 56, behavior: "host agent-run-failed fallback payloads (⚠️ Agent run failed (model: …)) are suppressed at capture like Plan-540 fallbacks — never captured, never humanized, never delivered",
     tags: ["agent-run-failed suppression"] },
   ```
   Tag = Substring der neuen Testnamen.

**Verify**: `npm test` → all pass; `node test/parity-matrix.mjs --check`
→ `56/56 covered`, exit 0.

## Test plan

Siehe Step 2. Verification: `npm test` all pass; Parity 56/56.

## Done criteria

- [ ] `grep -n "AGENT_RUN_FAILED_RE" lib/naturalize.js` → 2 Treffer (Def + Use)
- [ ] `npm test` exit 0 inkl. neuer Cases; Parity `56/56 covered`
- [ ] `git status` nur In-Scope-Dateien
- [ ] `plans/README.md` Status-Row aktualisiert (vom Reviewer)

## STOP conditions

- Die isSystemFallbackText-Zeilen bei `1e11ffe` passen nicht zum Zitat.
- Ein bestehender Plan-540-Test bricht inhaltlich → melden.

## Maintenance notes

- Der zugrundeliegende Agent-Run-Fehler („Session transcript keyed user is
  outside the current turn", 4× heute, auch kletter-internal) ist
  HOST-seitig und hier NICHT fixbar — Operator: OpenClaw-Update-Check
  (scout) und/oder Issue gegen OpenClaw; der Filter macht das Plugin
  dagegen unempfindlich.
- Reviewer-Schwerpunkt: anchoring (kein false positive bei Mitgliedern,
  die zufällig „agent run failed" tippen), Plan-540-Semantik unverändert.
