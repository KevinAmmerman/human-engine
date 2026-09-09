# Plan 023: return_greeting + Thread-Callback — Proaktive Rückkehr nach Abwesenheit, offene Threads als Trigger (shadow-first)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git -C ~/human-engine diff --stat c4e148b..HEAD -- lib/proactive.js lib/threads.js lib/config.js test/proactive.test.js`
> On mismatch mit den "Current state" excerpts: STOP condition.

## Status

- **Priority**: P2
- **Effort**: M–L
- **Risk**: MED (autonome Gruppennachrichten — deshalb shadow-first über den bestehenden Funnel; Budget/Cooldown-Mathematik für Tages-Skalen muss stimmen)
- **Depends on**: 022 (Thread-State liefert agentAbsentSince + openTopics)
- **Category**: direction
- **Planned at**: commit `c4e148b`, 2026-09-09

## Why this matters

„Meaningful Absence" Teil 2: Der Agent soll wie ein echtes Mitglied nach
mehrtägiger Abwesenheit MIT EINEM konkreten Bezug zurückkommen (einen
offenen Thread aufgreifen oder die Abwesenheit kurz würdigen — nie ein
generisches „hi again"), und er soll eine fällige Antwort aus einem
offenen Thread (`whoOwesWhat` auf den Agenten) proaktiv einlösen. Das
Design (meaningful-absence.md §3+§4 + social-memory-v2.md §4 callbackWorthy)
gibt Trigger, Guards und Budget vor. Der 30-Min-Tick erzeugt dabei KEINE
generischen Sprech-Turns (Anti-Pattern §3) — nur diese qualifizierten
Trigger.

## Current state

`lib/proactive.js` (bei `c4e148b`, 689 Zeilen) — 3-Stufen-Funnel:

- Stufe 1 Triggers: `unansweredQuestion`, `stalledExchange`,
  `contextMatch`, `followUpCommitment`, `outcomeCelebration`,
  `checkInOnPromise` (Config `proactive.triggers.*`, config.js:58-65).
  Trigger-Feuer mit Minuten-Skalen: `STALLED_BASE_MS` 20 min,
  `COMMITMENT_DELAY_MS` 120 min (Z. 14-18). Templates in
  `MESSAGE_TEMPLATES` (Z. ~48+). `COOLDOWN_CAP_MS` = 48 h (Z. 18).
- Stufe 2 Anti-Annoyance: Budget (`budgetPerDay` 2,
  `recognitionBudgetPerDay` 1 — RECOGNITION_TYPES-Set Z. ~41), minGap,
  adaptive cooldown, quiet hours, `probability` 0.5 (config.js:48-57).
- Stufe 3: `proactiveDecide`-LLM (buildProactiveDecidePrompt, SPEAK/SKIP)
  → Delivery via `api.runtime.subagent.run`. `shadow:true` = nur Logging
  (aktuell live: `proactive: { enabled: true, shadow: true }`).
- Der Tick (index.js:154-157, 30 min unref'd) ruft `proactive.tick()`.

`lib/threads.js` (nach Plan 022): `contextFor(sk, agentId)` → Zeile;
Agent-API für State: `__stateForTests` + `onActivity/onSpeak`. Für diesen
Plan braucht proactive Zugriff auf `agentAbsentSince` + `openTopics`
roh — ergänze in Plan-022-Manier einen kleinen Export
`threads.snapshotFor(sk, agentId)` → `{ agentAbsentSince, lastGroupActivityTs,
lastAgentSpeakTs, openTopics } | null` (eine Funktion, keine Duplikate).

Design-Zitate (meaningful-absence.md §4): „return_greeting: fires only when
agentAbsentSince > 24 h and the gap is meaningful (see §3), budget 1/day,
shadow-first"; „COOLDOWN_CAP_MS (48 h) must be re-examined so it does not
suppress multi-day returns". §3 Guards: keine unbeantwortete direkte
Ansprache des Agents, keine `awaiting: "agent"`-Topics (die sind
Callback-Sache, nicht Greeting), Gruppe still ODER letzte Aktivität
selbst-contained.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Unit | `node --test test/proactive.test.js test/threads.test.js` | all pass |
| Tests | `npm test` | all pass, 0 fail |
| Parity | `node test/parity-matrix.mjs --check` | fully covered, exit 0 |

## Scope

**In scope**:
- `lib/proactive.js` (zwei neue Trigger + Budget/Cooldown-Carve-outs)
- `lib/config.js` + `openclaw.plugin.json` (`proactive.triggers.returnGreeting`
  + `threadCallback`, `returnGreetingBudgetPerDay`)
- `lib/threads.js` (`snapshotFor`-Export — 5 Zeilen)
- `test/proactive.test.js` (Trigger/Guard/Budget-Cases)

**Out of scope**:
- Der 30-min-Tick als „soll-ich-sprechen"-Timer (Design-Anti-Pattern —
  unverändert)
- DM-proactive (eigener Funnel)
- MESSAGE_TEMPLATES für ALTE Trigger

## Git workflow

- Branch: `advisor/023-return-greeting-thread-callback`
- 2–3 Commits; Stil `plan 023: …`

## Steps

### Step 1: snapshotFor in threads.js

```js
function snapshotFor(sk, agentId) { /* load-or-rebuild wie contextFor; return roh */ }
```
Return im createThreads-Objekt ergänzen. (Kein Rendering, keine Guards —
reine Daten. 0600-Semantik unverändert.)

**Verify**: `node --test test/threads.test.js` → pass.

### Step 2: return_greeting-Trigger

In `lib/proactive.js`:

1. Config-Defaults: `triggers.returnGreeting: false`,
   `returnGreetingBudgetPerDay: 1` (default OFF — pro Gruppe live flippen).
2. Trigger-Check (in der Tick-Kandidaten-Erzeugung, Muster: bestehende
   Trigger-Funktionen um `stalledExchange`, Z. ~468):
   ```js
   const snap = threads?.snapshotFor(sk, agentId);
   if (snap && snap.agentAbsentSince > 24 * 3600e3 && qualifiesReturnGreeting(snap, peek)) {
     /* Kandidat type "return_greeting", reason: topic oder gap */
   }
   ```
3. `qualifiesReturnGreeting(snap, peek)` (Design §3):
   - KEIN unbeantwortetes `awaiting:"agent"`-Topic (sonst ist es
     threadCallback-Sache, kein Greeting — scharfe Trennung),
   - KEINE unbeantwortete direkte Ansprache im Peek (bestehender
     unansweredQuestion-Kandidat würde eh feuern),
   - Agent-Name nicht in den letzten 5 Peek-Zeilen (frisch angesprochen
     → kein „ich bin zurück" nötig).
4. Budget: eigener Tages-Bucket (`return_greeting` im byKind-ähnlichen
   Zähler des Funnels — reuses die Budget-Maschinerie; recognition-artig,
   aber EIGENER Key + `returnGreetingBudgetPerDay`).
5. Cooldown-Carve-out: `COOLDOWN_CAP_MS` 48 h unterdrückt
   Multi-Day-Returns NICHT mehr für return_greeting — Trigger-spezifisch:
   der return_greeting-Kandidat umgeht die adaptive Cooldown-Kappe mit
   eigenem minimal-Abstand von `7 * 24 h` (eine Rückkehr pro Woche pro
   Scope, einfache Mathematik statt Cooldown-Basteln).
6. Shadow: bestehende Funnel-Semantik (shadow = log only) — keine
   Sonderfälle.

**Verify**: `node --test test/proactive.test.js` → pass (Cases Step 4).

### Step 3: threadCallback-Trigger (callbackWorthy, Design §4)

1. Config: `triggers.threadCallback: false` (default OFF).
2. Kandidat, wenn `snapshotFor.openTopics` ein Topic mit
   `awaiting === "agent"` UND `lastTs` verfallend (older als
   `threadCallbackMinAgeHours` default 20 h, younger als 14-Tage-Expiry)
   enthält.
3. Reason-Zeile für den Kandidaten: `topic + lastExchange` (1 Satz) — der
   proactiveDecide-LLM („Evaluate skeptically") bleibt die Stufe 3.
4. Budget: normales `budgetPerDay`-Bucket (kein eigenes), byKind-Key
   `thread_callback`.
5. Template (MESSAGE_TEMPLATES ergänzen): Deutsch, 1–2 Sätze, greift das
   Topic konkret auf; keine Entschuldigungs-Kaskade.

**Verify**: `node --test test/proactive.test.js` → pass.

### Step 4: Tests + Parity

1. return_greeting feuert: absent 30 h, keine awaiting, kein Name im Peek
   → Kandidat type return_greeting; 25 h → kein Kandidat (Threshold).
2. Guards: awaiting-topic vorhanden → KEIN greeting (threadCallback
   prüft separat); Agent frisch angesprochen → kein Kandidat.
3. Budget: 2. Kandidat am selben Tag → blockt; 7-Tage-Abstand → erlaubt.
4. threadCallback: awaiting-Topic, 20 h alt → Kandidat; 5 h alt → keiner;
   15 d alt → keiner (Expiry). whoOwesWhat auf Mitglied → kein Kandidat.
5. shadow:true → Kandidat nur geloggt (bestehendes Muster).
6. Beide Trigger off (default) → null Kandidaten (Off-Vertrag).
7. Parity-Rows: „return_greeting trigger fires on meaningful >24h absence
  with guards + own budget (shadow-first, off by default)" +
  „thread callback trigger turns agent-owed open threads into funnel
  candidates (callbackWorthy)".

**Verify**: `npm test` → all pass; Parity fully covered.

## Test plan

Siehe Step 4. Muster: bestehende proactive-Trigger-Tests (Fake-state,
Fake-peek, injectierte Clock via `_now`-Override, falls das Modul so
testbar ist — bestehende Tests zeigen den Weg).

## Done criteria

- [ ] `rg -n "return_greeting|threadCallback" lib/proactive.js lib/config.js openclaw.plugin.json` → Treffer
- [ ] `rg -n "snapshotFor" lib/threads.js lib/proactive.js` → Treffer
- [ ] `npm test` exit 0 inkl. neuer Cases; Parity fully covered
- [ ] `plans/README.md` Status-Row aktualisiert

## STOP conditions

- Plan 022 nicht gelandet → STOP (Hard-Dependency).
- Die Budget-Maschinerie des Funnels erweist sich als nicht um einen
  per-trigger-Key erweiterbar ohne Refactor >2 Dateien → Report mit
  Skizze, KEIN Eigenbau-eines-zweiten-Budget-Systems.
- Ein bestehender Trigger-Test bricht durch die Tick-Erweiterung → Report.

## Maintenance notes

- Live-Rollout NUR shadow-first: `proactive.shadow:true` (aktuell live),
  Trigger-Flags je Gruppe flippen, ≥7 Tage Shadow-Review im
  Gateway-Log (Kandidat + proactiveDecide-Verdict), dann live.
- Kalibrierung: state/social-threads-Historie zeigt reale
  Gap-Verteilungen (Design §7.1) — Thresholds 24 h/20 h/7 d sind
  Startwerte, nach Review anpassbar (Config, kein Code).
- return_greeting und threadCallback schließen sich pro Turn aus
  (Guard aus Step 2.3) — genau EINE Rückkehr-Botschaft.
- Der proactiveDecide-Prompt („trigger may have been fired by pattern
  matching") passt automatisch — die Reason-Zeile ist die Kandidat-
  Beschreibung.
