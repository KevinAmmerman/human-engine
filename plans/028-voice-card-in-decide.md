# Plan 028: Voice-Card in den Decide — das Speak/Silent-Urteil sieht endlich das Register des Raums

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git -C ~/human-engine diff --stat c4e148b..HEAD -- lib/gate.js lib/persona.js lib/local-engine.js test/gate.test.js`
> On mismatch mit den "Current state" excerpts: STOP condition.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: MED (Decide-Prompt wächst um Karte + Style-Constraint; Verhaltensänderung der Decide möglich — absicherbar über die decide-eval-Fixtures; ideal NACH 024, damit Contract-Wechsel und Context-Wechsel getrennt getestet werden)
- **Depends on**: 024 ideal (Sequenz, kein Hard-Dep); 026 (Style-Filter — sonst lernt der Decide den kontaminierten Constraint mit)
- **Category**: direction
- **Planned at**: commit `c4e148b`, 2026-09-09

## Why this matters

Das Speak/Stay-Silent-Urteil fällt in kompletter Unkenntnis des
Gesprächs-Registers: `gate.js` übergibt `persona: decidePersona` (NUR die
rohe SOUL, aus buildSoulPrompt) und `voiceCard: null` — der Split-Pfad
bekommt dagegen die volle Persona (SOUL + Voice Card + Style-Stats +
Anti-Tell). Ein lockere, emoji-lastige, Kurz-Nachrichten-Gruppe hat eine
ANDERE Interventions-Schwelle als eine formelle — genau das Wissen, das
ein Mensch für „würde ich mich da einmischen?" nutzt. Gate und Phrasierung
urteilen heute über denselben Raum mit unterschiedlichen Fakten.

## Current state

`lib/gate.js:236-237` (bei `c4e148b`):

```js
const systemPrompt = persona?.buildPersonaPrompt(agentCfg, sk, ctx?.agentId || agentIdFromSessionKey(sk));
const decidePersona = persona?.buildSoulPrompt ? persona.buildSoulPrompt(agentCfg) : null;
```

`lib/gate.js:352-367` (engine.decide-Call):

```js
const engineResult = await engine.decide({
  sessionKey: sk,
  messages,
  systemPrompt: systemPrompt || undefined,
  …
  transcript: transcriptLines,
  persona: decidePersona || undefined,
  voiceCard: null,
  …
});
```

`lib/persona.js`: `buildPersonaPrompt(cfg, sessionKey, agentId)` = SOUL +
Voice Card (voiceCardGetter) + ANTI_TELL_BLOCK + Style-Constraint;
`buildSoulPrompt(cfg)` = nur SOUL. local-engine.decide ignoriert den
`systemPrompt`-Parameter (baut buildDecidePrompt aus persona/voiceCard) —
d.h. der `systemPrompt`-Param am gate-Call ist heute ein toter Zweitpfad
(bereinigen siehe Step 1.3).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Unit | `node --test test/gate.test.js test/persona.test.js test/decide-eval.test.js` | all pass |
| Tests | `npm test` | all pass, 0 fail |
| Parity | `node test/parity-matrix.mjs --check` | fully covered, exit 0 |

## Scope

**In scope**:
- `lib/gate.js` (decidePersona auf buildPersonaPrompt umstellen;
  systemPrompt-Totpfad-Parameter am decide-Call entfernen)
- `test/gate.test.js` (Args-Assertions)
- `test/decide-eval.test.js` (Fixture-Szenarien: casual-vs-formal-Gruppe,
  Erwartung bleibt SPEAK/STAY_SILENT-STABIL — siehe Test plan)
- `test/parity-matrix.mjs` (eine Row)

**Out of scope**:
- `lib/persona.js` (unverändert genutzt)
- `lib/local-engine.js` (decide-Signatur bleibt; persona-Inhalt ändert sich)
- Token-Slimming des Decide-Prompts (PERF-04 ist ein eigenes Thema —
  NICHT hier; Note in Maintenance)

## Git workflow

- Branch: `advisor/028-voicecard-in-decide`
- 1 Commit; Stil `plan 028: …`

## Steps

### Step 1: decidePersona umstellen

1. `lib/gate.js:237`:
   ```js
   const decidePersona = persona?.buildPersonaPrompt
     ? persona.buildPersonaPrompt(agentCfg, sk, ctx?.agentId || agentIdFromSessionKey(sk))
     : null;
   ```
2. `voiceCard: null` bleibt (buildDecidePrompt hängt voiceCard als
   EIGENE Sektion an — die Karte ist jetzt schon im persona-Block; ein
   zweites Mal wäre Duplikat).
3. Den toten `systemPrompt`-Parameter aus dem engine.decide-Call Z. 355
   entfernen (buildPersonaPrompt-Ergebnis läuft über `persona`; der
   lokale systemPrompt-Param von gate wird sonst nirgends im
   LLM-Pfad genutzt). Wenn Tests den Parameter am Fake fangen:
   Expectation entfernen (Totpfad, kein Verhalten).

**Verify**: `node --test test/gate.test.js` → pass (Step 2-Tests).

### Step 2: Tests

1. gate: Fake-engine fängt decide-Args → persona enthält die Voice Card
   (Fake-voiceCardGetter via setVoiceCardGetter) UND den Style-Constraint
   (Peek ≥10 Zeilen), `voiceCard` arg bleibt null, kein `systemPrompt`-Arg.
2. Ohne Card/ohne Peek-Stats: persona = SOUL(+ANTI_TELL) — kein Bruch.
3. decide-eval (Fixture-Layer): 2 neue Szenarien — lockere Gruppe
   („haha nice lol") und formelle — die BESTEHENDEN
   SPEAK/STAY_SILENT-Erwartungen der 33 Fixtures dürfen sich NICHT drehen
   (decide-eval.test.js gegen die Fixtures laufen lassen; wenn ein
   Szenario flippt → STOP-Bedingung).
4. Parity-Row: „decide persona includes the group voice card + style
  constraint (register-aware turn-taking); voiceCard param stays null to
  avoid duplication".

**Verify**: `npm test` → all pass; Parity fully covered.

## Test plan

Siehe Step 2. Anker: bestehende gate-Fake-engine-Args-Tests +
decide-eval-Fixtures (das Flip-Verbot ist der eigentliche Vertrag).

## Done criteria

- [ ] `rg -n "buildSoulPrompt" lib/gate.js` → kein Treffer mehr (decide-Pfad)
- [ ] `rg -n "voiceCard: null" lib/gate.js` → weiterhin da (bewusst)
- [ ] `npm test` exit 0; decide-eval ohne Szenario-Flip; Parity fully covered
- [ ] `plans/README.md` Status-Row aktualisiert

## STOP conditions

- ≥2 decide-eval-Szenarien flippen ihre Erwartung → Report mit den
  Szenario-Namen + vor/nach-Entscheidung (echter Verhaltensregress des
  Gates — der Operator entscheidet, ob die neuen Urteile besser sind).
- Fake-Tests verankern den toten systemPrompt-Param als Vertrag →
  Report; NICHT heimlich doch übergeben.

## Maintenance notes

- Live-Beobachtung nach Rollout: `decide-ctx`/`claim`-Logs — wenn die
  Gruppe casual ist, SOLLTE speak öfter vorkommen (niedrigere
  Interventionsschwelle in lockeren Räumen). Nach 48 h Review.
- Token-Note: Decide-Prompt wächst um ~300–600 Zeichen (Karte+Stats).
  Das ist bewusst; wenn Kosten zählen: ein „decide-slim"-Thema wäre
  ein EIGENER Plan (kompakte Karten-Zusammenfassung), nicht ad-hoc
  Kürzen.
- Anti-Tell-Block reist jetzt mit in den Decide-Prompt — er ist dort
  funktionslos aber harmlos (Output bleibt 1 Token); akzeptiert, damit
  buildPersonaPrompt EINE Quelle bleibt.
