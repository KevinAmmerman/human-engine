# Plan 024: Decide-Contract v2 — SPEAK/STAY_SILENT als Mini-JSON mit reason + addressed_to, auditierbar

> **Executor instructions**: Follow this plan step by. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git -C ~/human-engine diff --stat c4e148b..HEAD -- lib/local-engine.js lib/local-prompts.js lib/gate.js lib/proactive.js test/local-engine.test.js test/decide-eval.test.js test/fixtures/decide-scenarios.json`
> On mismatch mit den "Current state" excerpts: STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (Contract-Wechsel am heißesten LLM-Call; Absicherung über Token-Fallback (Plan 016) + Config-Flag + fail-open-/fail-closed-Semantik unverändert)
- **Depends on**: 016 (parseDecideVerdict als Fallback-Ebene), ideal NACH 021/022 (Memory-/Thread-Kontext zuerst, dann Contract — sonst doppelte Decide-eval-Zykle)
- **Category**: direction
- **Planned at**: commit `c4e148b`, 2026-09-09

## Why this matters

Die Decide-Entscheidung ist heute EIN unbeobachtbares Token: Kein Grund,
kein Adressat, nichts auditierbar. Folgen: stay_silent-Fälle sind weder
im Log erklärbar noch per Gruppe tunbar; das Addressee-Rätsel (die Kern-
Herausforderung für „teilnehmen wie ein Mitglied") ist delegiert an einen
8-Token-Wurf ohne Signal. Contract v2: Mini-JSON
`{"decision":"SPEAK","reason":"…","addressed_to":"name"}` — der Grund landet
im Log (PII-safe: kurze, vom Modell generierte Phrase), addressed_to
ernaährt künftiges Tuning (falsch erkannte Adressaten sichtbar machen).
Der proactiveDecide (SPEAK/SKIP) wandert mit (gleiche Bauweise), damit
beide Contracts über einen Helper laufen.

## Current state

`lib/local-prompts.js:157` (decide) — `'Answer with EXACTLY one token: SPEAK or STAY_SILENT.'`
`lib/local-prompts.js:181` (proactive) — `'Answer with EXACTLY one token: SPEAK or SKIP.'`
`lib/local-engine.js:70-96` — decide-Aufruf `maxTokens: 8`,
Verdict via Plan 016 (parseDecideVerdict) nach Landung, sonst `=== "SPEAK"`.
`lib/proactive.js` ~612-623 — proactiveDecide-Verdict analog (SPEAK/SKIP).
Log-Zeile: gate.js:300 `claim … decision=… path=… epoch=…` (kein Grund).

Config: `decide: { temperature: 0.2 }` (config.js:31-33).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Unit | `node --test test/local-engine.test.js test/gate.test.js test/decide-eval.test.js test/local-prompts.test.js` | all pass |
| Tests | `npm test` | all pass, 0 fail |
| Parity | `node test/parity-matrix.mjs --check` | fully covered, exit 0 |

## Scope

**In scope**:
- `lib/local-prompts.js` (beide Prompt-Contract-Zeilen + JSON-Schema-Zeile)
- `lib/local-engine.js` (decide: maxTokens 8→48, JSON-Parse + Fallback;
  neuer Export `parseDecideVerdictV2`)
- `lib/proactive.js` (proactiveDecide-Verdict über denselben Helper)
- `lib/config.js` + `openclaw.plugin.json` (`decide.v2Contract`, default false)
- `lib/gate.js` (nur Log-Zeile: reason/addressed in claim-Log)
- Tests + decide-eval-Fixtures + Parity-Rows

**Out of scope**:
- Fail-open/fail-closed-Pfade (engine null → unverändert)
- Epoch-/Silence-Maschinerie
- decide-eval-live.mjs (Live-Script — nur wenn die Fixture-Format-Zeilen
  es erzwingen; sonst Maintenance-Note)

## Git workflow

- Branch: `advisor/024-decide-contract-v2`
- 2–3 Commits; Stil `plan 024: …`

## Steps

### Step 1: Config-Flag + Prompt-Contract

1. `decide.v2Contract: false` default (+ Schema).
2. In buildDecidePrompt/buildProactiveDecidePrompt — bei `v2Contract` (neuer
   Param, vom Aufrufer aus cfg gelesen):
   ```js
   'Answer with STRICT JSON only: {"decision":"SPEAK"|"STAY_SILENT","reason":"<=8 words why","addressed_to":"<name or group>"}'
   ```
   (proactive: "SPEAK"|"SKIP"). v1-Token-Zeile bleibt im else-Zweig
   unverändert.

**Verify**: `node --test test/local-prompts.test.js` → pass (neue Contract-Tests).

### Step 2: parseDecideVerdictV2

```js
export function parseDecideVerdictV2(raw) {
  const text = String(raw || "");
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  let parsed = null;
  if (s >= 0 && e > s) { try { parsed = JSON.parse(text.slice(s, e + 1)); } catch {} }
  if (parsed && typeof parsed.decision === "string") {
    const d = parsed.decision.toUpperCase();
    if (d === "SPEAK" || d === "STAY_SILENT" || d === "SKIP") {
      return {
        decision: d === "SKIP" ? "SKIP" : d,
        reason: typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 60) : "",
        addressedTo: typeof parsed.addressed_to === "string" ? parsed.addressed_to.trim().slice(0, 40) : "",
      };
    }
  }
  // Token-Fallback (Plan 016): Modell antwortete Token statt JSON
  const tok = parseDecideVerdict(text);
  return tok ? { decision: tok, reason: "(token-fallback)", addressedTo: "" } : null;
}
```

decide(): bei v2Contract `maxTokens: 48`, Verdict über
parseDecideVerdictV2; null → stay_silent (Status quo für Müll); reason/
addressedTo ins engineResult aufnehmen (`{ decision, epoch, path,
reason, addressedTo }`). STAY_SILENT-Epoch-Semantik unverändert (nur
speak advanced die Epoch).

**Verify**: `node --test test/local-engine.test.js` → pass (Step 4-Cases).

### Step 3: Gate-Log + proactiveDecide

1. gate.js claim-Log (Z. ~300) ergänzen: `reason=… addressed=…` (nur wenn
   vorhanden; Grund-Kürzung 60 — Log bleibt PII-arm: Modell-Phrase über
   Gruppeninhalt ist bewusst kurz).
2. proactive.js proactiveDecide-Verdict über parseDecideVerdictV2
   (SKIP/Token-Fallback funktioniert — parseDecideVerdict deckt SKIP nach
   kleiner Erweiterung: `/\b(SPEAK|STAY_SILENT|SKIP)\b/` — an Plan 016
   anlehnen; 016 landet vor diesem Plan).

**Verify**: `node --test test/gate.test.js test/proactive.test.js` → pass.

### Step 4: Tests + Fixtures + Parity

1. parseDecideVerdictV2: sauberes JSON; JSON in Fences; Token-Fallback;
   Müll → null→stay_silent; reason >60 gekappt.
2. gate: Fake-engine liefert v2-Result → claim-Log enthält reason
   (Log-Recorder-Fake).
3. decide-eval.test.js + fixtures: Contract-Layer erweitert — v2Contract
   -Cases (Systemzeile enthält STRICT-JSON-Zeile); bestehende v1-Cases
   unverändert (Flag off).
4. Parity-Rows: „decide v2Contract emits audit reasons/addressed_to with
  token fallback (default off)".

**Verify**: `npm test` → all pass; Parity fully covered.

## Test plan

Siehe Step 4. Anker: Plan 016-Characterization-Tests + decide-eval.

## Done criteria

- [ ] `rg -n "parseDecideVerdictV2" lib/` → Export + 2 Consumer (decide + proactive)
- [ ] `rg -n "v2Contract" lib/config.js openclaw.plugin.json lib/local-engine.js` → Treffer
- [ ] `npm test` exit 0; Parity fully covered
- [ ] `plans/README.md` Status-Row aktualisiert

## STOP conditions

- Plan 016 nicht gelandet → STOP (Fallback-Basis fehlt).
- Token-Fallback-Präzedenz kollidiert mit einem 016-Test → Report.
- maxTokens:48 ändert ein Modellverhalten so, dass ein gelabeltes
  decide-eval-Szenario flippt → Report mit Szenario-Name (echter
  Verhaltensregress — kein Test-Rauschen).

## Maintenance notes

- Live-Rollout: `decide.v2Contract: true` nach einem decide-eval-Lauf
  (Scripts: scripts/decide-eval-live.mjs, mind. 33 Fixture-Szenarien);
  die reason-Phrasen im Gateway-Log sind das neue Tuning-Instrument.
- Token-Fallback bleibt Dauereinrichtung: Modell-Regressionen fallen auf
  v1-Token-Semantik zurück statt auf stay_silent.
- addressed_to ist Datenbasis für künftiges Adressat-Tuning (D5:
  Trigger-Comprehension) — NICHT in Persistenz/observed schreiben (nur
  Log + ephemeral).
- PII: reason-Phrasen können Namen enthalten — Log-Zeilen sind bereits
  redact-pflichtig (Plan 012); reason-Cap 60 hält es knapp.
