# Plan 030: Mood-Ausbau — Decay persistieren + Gruppen-Mood (Räume spürbar mitschwingen lassen)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git -C ~/human-engine diff --stat c4e148b..HEAD -- lib/mood.js lib/config.js lib/local-engine.js lib/naturalize.js openclaw.plugin.json test/mood.test.js`
> On mismatch mit den "Current state" excerpts: STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (Mood→Verhalten-Kopplung kann überschwenken — clampShift existiert; Gruppen-Mood war vormals als „by-design dm-only" abgelehnt — die Anfrage des Owners hebt das auf: Persönlichkeit/Natürlichkeit ist jetzt das Ziel. Shadow-first via Config-Flag.)
- **Depends on**: none (026 nice-to-have: Timing-ctx hourOfDay existiert dort schon)
- **Category**: direction
- **Planned at**: commit `c4e148b`, 2026-09-09

## Why this matters

Mood ist heute (a) kosmetisch: der Decay
(`applyDecay`, Richtung neutral über 6 h) wird NIE persistiert — die
nächste Appraisal rechnet vom unzerfallenen Zustand hoch, „Drift zur
Neutralität" passiert nur im Injection-Rendering; (b) halbgewollt: Mood
färbt nur den Haupt-Turn von DMs — Gruppen haben GAR KEIN Stimmungsbild,
obwohl „spüren, ob der Raum gerade abgefahren oder hype ist" der
Human-Hebel fürs Gruppenteilnehmen ist (decide-Schwelle + Timing +
Bubble-Anzahl). Der Plan: (1) Decay- Persistenz-Fix (klein, richtig),
(2) Gruppen-Mood hinter neuem Config-Flag `mood.groupsEnabled` (default
false, shadow-first wie mood selbst), mit drei Wirkorten:
Decide-Schwelle (Energie des Raumes färbt speak/silent), Bubble-Budget
(hoch → mehr/längere Bubbles erlaubt; niedrig → knapp), Erst-Bubble-
Timing (hoch → schneller).

## Current state

`lib/mood.js` (bei `c4e148b`):

- `applyDecay(state, nowMs, decayHours)` (Z. 54-66) — returned eine
  GEHALTETE Kopie (valence/energy halbiert, note geleert) — nur für
  Injection genutzt (onBeforePromptBuild Z. 226-229).
- `maybeUpdateMood` (Z. 180-215): `current = readMood(...)` — UNzerfallen;
  Appraisal-Prompt bekommt das als „Aktueller Zustand" (Z. 92-94);
  `clampShift(current, parsed, maxShift)` + writeMood — d.h. nach jeder
  Appraisal springt der Mood vom unzerfallenen Ausgangswert.
- Gruppe explizit raus: `isGroupSessionKey(sk)` early-return in
  onMessageReceived (Z. 157) und onBeforePromptBuild (Z. 224).
- Injection: `renderInjection` (Z. 120-128) — „Current mood state
  (internal, never mention…)".
- Config `mood: { enabled, refreshEvery, refreshMinutes, decayHours,
  maxShiftPerUpdate }` (config.js:81-88); live `mood.enabled: true`.

Betroffene Consumer für Gruppen-Wirkorte (nach Plan 026): naturalize
flush baut triggerInfo + ruft engine.respond → buildSplitPrompt +
scheduleForBubbles; gate ruft engine.decide.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Unit | `node --test test/mood.test.js test/gate.test.js test/naturalize.test.js` | all pass |
| Tests | `npm test` | all pass, 0 fail |
| Parity | `node test/parity-matrix.mjs --check` | fully covered, exit 0 |

## Scope

**In scope**:
- `lib/mood.js` (decay-in-appraisal + Gruppen-Pfad + snapshotFor-API)
- `lib/config.js` + `openclaw.plugin.json` (`mood.groupsEnabled: false`,
  `mood.groupsRefreshEvery` default 10)
- `lib/gate.js` (Gruppen-Decide-Mood-Injection, eine Systemzeile)
- `lib/naturalize.js` + `lib/local-engine.js` (Timing-ctx.moodEnergy +
  buildSplitPrompt-Stilzeile — NUR Gruppen)
- `test/mood.test.js` + Integrations-Cases in gate/naturalize

**Out of scope**:
- `mood.enabled`-Semantik (Master-Switch bleibt; groupsEnabled ist ein
  ZWEITER Switch)
- DM-Pfade (unverändert — dort ist Mood live)
- Neue State-Files (bestehende mood/<agentId>/<sessionKey>.json wird
  auch für Gruppen genutzt — Pfad-Schema funktioniert für Gruppen-Keys)

## Git workflow

- Branch: `advisor/030-mood-expansion`
- 2–3 Commits; Stil `plan 030: …`

## Steps

### Step 1: Decay persistieren (Korrectheit)

In `maybeUpdateMood`:

```js
let current = readMood(stateDir, agentId, sessionKey);
current = applyDecay(current, Date.now(), cfg?.mood?.decayHours);
```

Appraisal + clampShift laufen auf dem ZERFALLENEN Zustand; writeMood
persistiert das Ergebnis. `onBeforePromptBuild` bleibt wie es ist
(Injection-Decay berechnen, NICHT zurückschreiben — Read-Pfad bleibt
billig). Effekt: Decay akkumuliert über Appraisal-Zyklen hinweg.

**Verify**: `node --test test/mood.test.js` → pass (Fall: Zustand 6 h alt →
nächste Appraisal startet bei halbiertem Wert).

### Step 2: Gruppen-Mood (hinter Flag)

1. Config: `mood.groupsEnabled: false`, `mood.groupsRefreshEvery: 10`.
2. mood.js: die beiden `isGroupSessionKey`-Early-Returns zu
   `if (isGroup && !groupsEnabled) return;` — onMessageReceived zählt +
   appraised bei `n % groupsRefreshEvery`; onBeforePromptBuild injiziert
   für Gruppen WIE für DMs (renderInjection unverändert — „internal,
   never mention" gilt ohnehin).
3. NEU `snapshotFor(agentId, sessionKey)` → `{ valence, energy } | null`
   (readMood + decay + clamp; null wenn neutral) — API für die zwei
   Gruppen-Wirkorte. Export im createMood-Return.

**Verify**: `node --test test/mood.test.js` → pass (Gruppen-Appraisal-Fall
bei Flag, Off-Fall ohne Datei/Injection).

### Step 3: Wirkorte verdrahten (nur Gruppen, nur wenn groupsEnabled)

1. gate.js onBeforeAgentReply (Gruppen-Zweig): vor decidePromise
   ```js
   const moodSnap = mood?.snapshotFor ? mood.snapshotFor(ctx?.agentId, sk) : null;
   ```
   → engine.decide zusätzlich `moodEnergy: moodSnap?.energy ?? null`;
   buildDecidePrompt: wenn moodEnergy ≠ null → EINE Systemzeile
   (bewusst schwach formuliert, daten-orientiert):
   `"Room energy right now: <label>. Let it color your threshold naturally — never mention it."`
   (ENERGY_LABELS via languagePack nach Plan 029 falls gelandet, sonst de-Labels).
2. naturalize flush (GRUPPEN-Pfad): triggerInfo ergänzen
   `moodEnergy: mood?.snapshotFor(...)?.energy ?? null`;
   local-engine respond-ctx: `hourOfDay` (Plan 026) + `moodEnergy`
   durchreichen an scheduleForBubbles; timing-engine readingDelayMs:
   `if (c.moodEnergy != null) d *= (1 - 0.06 * c.moodEnergy)` (energy -2
   → ×1.12 langsamer; +2 → ×0.88 schneller — KLEIN dosiert).
3. buildSplitPrompt (GRUPPEN): wenn moodEnergy ≤ -1 → Zusatzzeile
   „Keep it brief — 1–2 short bubbles."; wenn ≥ 1 → „A bit more room
   for energy is fine — still short." (nur Gruppen; DM-Splits laufen live
   eh nicht, disableDM).

**Verify**: `node --test test/gate.test.js test/naturalize.test.js test/local-engine.test.js test/timing-engine.test.js` → pass.

### Step 4: Tests + Parity

1. Decay-Akkumulation (Step 1): 2 Appraisals 7 h auseinander → zweiter
   startet vom halbierten Wert.
2. Gruppen: Flag off → keine Appraisal/Injection/Datei (Off-Vertrag);
   Flag on → Appraisal alle groupsRefreshEvery, Injection im
   before_prompt_build.
3. gate: moodEnergy +2 → decide-Systemprompt enthält Room-energy-Zeile
   (Fake-Recorder).
4. timing: moodEnergy ±2 verschiebt Erst-Delay um ≤12 % (RNG fix).
5. Klemmen: energy +2 + weitere Appraisal +2 → clampAxis ±2 (kein
   Überhitzen — bestehende clampShift-Tests decken).
6. Parity-Rows: „mood decay persists across appraisals (no undecayed
  baseline re-raise)" + „group mood (flagged) feeds decide room-energy
  line, first-bubble timing and split brevity — never mentioned aloud".

**Verify**: `npm test` → all pass; Parity fully covered.

## Test plan

Siehe Step 4. Muster: mood.test.js (Fake-llm-Appraisal, Fake-Clock über
updatedAt) + gate-Fakes.

## Done criteria

- [ ] `rg -n "applyDecay" lib/mood.js` → auch im maybeUpdateMood-Pfad
- [ ] `rg -n "groupsEnabled" lib/mood.js lib/config.js openclaw.plugin.json` → Treffer
- [ ] `rg -n "moodEnergy" lib/ test/` → Wirkorte + Tests
- [ ] `npm test` exit 0; Parity fully covered
- [ ] `plans/README.md` Status-Row aktualisiert

## STOP conditions

- Gruppen-Appraisal überfordert die LLM-/fs-Budgets sichtbar (pro Gruppe
  +1 Appraisal pro 10 Nachrichten) → refreshEvery hochsetzen ist OK
  (Config-Wert), Architektur-Report nur wenn >1 Call pro Nachricht.
- Ein bestehender dm-only-Test verankert das Fehlen von Gruppen-Mood als
  Vertrag (nicht nur als Test-Setup) → Report (die alte Ablehnung wurde
  vom Owner aufgehoben — aber das muss im Review sichtbar sein).
- buildDecidePrompt-Zeile ändert decide-eval-Szenarien → wie Plan 028:
  Report mit den Szenario-Namen.

## Maintenance notes

- Die frühere „considered and rejected"-Entscheidung (Gruppen-Mood
  dm-only, Plan 570) wird durch diese Owner-Anfrage superseded — in
  plans/README bei Landung in der Rejected-Liste als „superseded by
  030" markieren.
- Live-Rollout: `mood.groupsEnabled: true` NUR auf eine Gruppe (Kletter),
  7 Tage beobachten (decide-Logs + wie sich die Bubbles anfühlen), dann
  zweite Gruppe. Mood bleibt sonst unverändert.
- Dosierung ist bewusst klein (12 % Timing, 1 Prompt-Zeile, clamp ±2) —
  Übertreiben ist der bekannteste Mood-Fehler; bei „Agent wirkt launisch"
  zuerst maxShiftPerUpdate/decayHours tunen, nicht mehr Wirkorte.
