# Plan 016: Decide-Output-Parsing robust machen — SPEAK/STAY_SILENT auch mit Modell-Rauschen erkennen

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git -C ~/human-engine diff --stat c4e148b..HEAD -- lib/local-engine.js test/local-engine.test.js`
> On mismatch with the "Current state" excerpt: STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (nur Erweiterung des Akzeptanzfensters; exakte Token bleiben First-Class)
- **Depends on**: none
- **Category**: bug / tests
- **Planned at**: commit `c4e148b`, 2026-09-09

## Why this matters

Die Decide-Antwort entscheidet, ob der Agent ÜBERHAUPT antwortet. Heute
greift nur exakter `=== "SPEAK"` nach trim+toUpperCase (local-engine.js:82).
Ein Modell, das `` ```SPEAK``` ``, `SPEAK (respond)`, `"decision":"SPEAK"`
oder „I think SPEAK" liefert (typische Regression bei maxTokens:8 /
Modellwechsel), fällt still auf `stay_silent` — exakt die
„hori wirkt tot"-Vorfallsklasse, die dieses Plugin verhindern will. Dazu
existieren NULL Tests für dieses Parsing (bestehende Tests füttern nur
saubere Tokens). Plan 024 ersetzt später den Contract durch JSON — dieser
Plan härtet das HEUTIGE Token-Format, sodass die Live-Systeme bis dahin
robust sind (und 024 baut auf demselben Extraktionshelper auf).

## Current state

`lib/local-engine.js:69-96` (bei `c4e148b`):

```js
try {
  const result = await llm.complete({
    messages: [ /* decidePrompt.systemPrompt / userMessage */ ],
    temperature: cfg?.decide?.temperature ?? 0.2,
    maxTokens: 8,
    purpose: "human-engine-decide",
    agentId: agentIdFromSessionKey(sessionKey) || undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = (result?.text || "").trim().toUpperCase();
  if (text === "SPEAK") {
    // → speak + epoch
  }
  return { decision: "stay_silent", epoch: prev, path: "llm" };
} catch (err { ... return null; }
```

trim+toUpperCase existiert schon — der Gap ist Fences/JSON/Prosa um das
Token. Der Prompt fordert „Answer with EXACTLY one token: SPEAK or
STAY_SILENT" (local-prompts.js:157).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Unit | `node --test test/local-engine.test.js` | all pass |
| Tests | `npm test` | all pass, 0 fail |
| Parity | `node test/parity-matrix.mjs --check` | fully covered, exit 0 |

## Scope

**In scope**:
- `lib/local-engine.js` (neue `parseDecideVerdict(raw)` + Verwendung in decide)
- `test/local-engine.test.js` (Characterization-Cases)
- `test/parity-matrix.mjs` (eine neue Row am Ende)

**Out of scope**:
- `buildDecidePrompt` (Prompt-Inhalt unverändert — der Contract-Wechsel ist Plan 024)
- Proactive-decide (`buildProactiveDecidePrompt`, proactive.js) — dessen
  Parsing hat dasselbe Muster; HIER nicht anfassen, damit 024 beide in
  einem Zug auf JSON umstellt. (Maintenance-Note dokumentiert den Zweitort.)
- maxTokens/Fail-open-/Fail-closed-Semantik

## Git workflow

- Branch: `advisor/016-decide-parse`
- 1 Commit; Stil `plan 016: …`

## Steps

### Step 1: parseDecideVerdict einführen

Exportierter Helper in `lib/local-engine.js`:

```js
export function parseDecideVerdict(raw) {
  const text = String(raw || "").toUpperCase();
  if (text.trim() === "SPEAK") return "SPEAK";
  if (text.trim() === "STAY_SILENT") return "STAY_SILENT";
  // Fences/Prosa/JSON: erstes Vorkommen eines der beiden Tokens
  const m = /\b(SPEAK|STAY_SILENT)\b/.exec(text.replace(/[`*"]/g, " "));
  return m ? m[1] : null;
}
```

In `decide()` verwenden:

```js
const verdict = parseDecideVerdict(result?.text || "");
if (verdict === "SPEAK") { /* speak + epoch, unverändert */ }
return { decision: "stay_silent", epoch: prev, path: "llm" };
```

`null` (kein Token gefunden) → stay_silent (Status quo für Müll — bewusst
still, Gruppe fail-closed via engine-null bleibt davon unberührt).

**Verify**: `node --test test/local-engine.test.js` → pass (Cases Step 2).

### Step 2: Characterization-Tests

In `test/local-engine.test.js` (Muster: bestehende decide-Tests mit Fake-llm):

1. `"SPEAK"`, `"  speak  "`, `"Speak"` → SPEAK (Bestehendes dokumentiert).
2. `` "```SPEAK```" `` → SPEAK. 3. `"SPEAK (respond)"` → SPEAK.
4. `'{"decision":"SPEAK"}'` → SPEAK. 5. `"[STAY_SILENT]"` → STAY_SILENT.
6. `"I think the answer is SPEAK"` → SPEAK.
7. `"Neither token present"` → null→stay_silent (decide-Pfad liefert
   stay_silent-Objekt).
8. `"STAY_SILENT because SPEAK was wrong"` → STAY_SILENT (Erstes
   Vorkommen gewinnt — Test dokumentiert die Präzedenz).
9. Bestehende Tests: unverändert grün.

Parity-Row am Ende: „decide verdict parsing tolerates model noise
(fences/JSON/prose) via token extraction, exact-match fast path first",
Tag = Substring neuer Testnamen.

**Verify**: `npm test` → all pass; Parity fully covered, exit 0.

## Test plan

Siehe Step 2. Anker: die bestehenden STAY_SILENT/unrelated-String-Tests.

## Done criteria

- [ ] `grep -n "parseDecideVerdict" lib/local-engine.js` → Def + Export + Use
- [ ] `npm test` exit 0 inkl. ≥8 neuer Cases; Parity fully covered
- [ ] `git status` nur In-Scope-Dateien
- [ ] `plans/README.md` Status-Row aktualisiert

## STOP conditions

- Excerpt passt nicht zu `c4e148b`.
- Ein bestehender decide-Test erwartete previously Müll-String → SPEAK
  (unwahrscheinlich; „I'm not sure…" → stay_silent bleibt korrekt) → Report.

## Maintenance notes

- proactive.js hat ein ZWEITES Token-Parsing (SPEAK/SKIP, ~Z. 612-623) —
  gleiche Härung bewusst NICHT hier, sondern mit Plan 024 zusammen
  (Contract-Wechsel betrifft beide). Wer vorher dort handanlegt: denselben
  Helper wiederverwenden.
- Plan 024 ersetzt den Token-Contract durch JSON — parseDecideVerdict wird
  dann zur Fallback-Ebene (escape hatch für Modell-Regression). Der Helper
  ist darauf ausgelegt zu bleiben.
