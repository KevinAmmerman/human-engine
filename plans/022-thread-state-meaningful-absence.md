# Plan 022: Thread-State — Meaningful Absence Teil 1: persistierte openTopics/agentAbsentSince + Decide-Injection + Rebuild

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git -C ~/human-engine diff --stat c4e148b..HEAD -- lib/ index.js test/`
> On mismatch: STOP condition. (Breites Diff — dieser Plan ist der erste, der ein NEUES Modul anlegt; Konflikte mit 009–021 sind über die Excerpts zu prüfen.)

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED (Over-Referentialität ist das Design-Risiko — Guards: 1 Kandidat pro Return, nur bei >24 h/awaiting; Persistenz + Rebuild neu)
- **Depends on**: 019, 020 (Person-Store + open_threads-Felder — Thread-Quelle), 021 (Compact-Recall filtert Threads aus, sobald Thread-Zeile existiert)
- **Category**: direction
- **Planned at**: commit `c4e148b`, 2026-09-09

## Why this matters

Echte Gruppenmitglieder sind „meaningfully absent": Sie verschwinden tagelang
und nehmen dann einen Thread wieder auf — oder einen, dem sie eine Antwort
schulden. Heute kann der Agent das nicht darstellen: Decide-Kontext =
letzte 20 Zeilen, mehr als Minuten Traffic. Das Design
(wiki/design/meaningful-absence.md §1+§2+§5) ist vollständig: persistierter
Thread-State pro Scope, eine Decide-Kontextzeile bei Rückkehr/oder
fälliger Antwort, Rebuild aus observed-store nach Restart. Dieser Plan
baut Teil 1 (State + Decide-Integration + Rebuild); die proaktive
return_greeting-Fire ist Plan 023.

## Current state

Relevanter Ist-Zustand (bei `c4e148b`):

- `lib/gate.js` decide-Kontext: transcriptLines (max 20) + persona; keine
  Thread-/Absence-Information. `markSpeak` (Z. 137-153) weiß nicht, wann
  der Agent zuletzt sprach.
- `lib/observed-store.js` persistiert silenced + eigene Replies mit `ts`
  (`appendObserved(sk, {speaker, text, ts: Date.now()}`) — Rebuild-Quelle.
  `readObserved(sk, last)` liefert `{speaker, text, ts}`.
- `lib/naturalize.js` `persistOwnReply` (Z. 151-161) schreibt eigene
  Antworten in den observed store — `lastAgentSpeakTs` ist daraus ableitbar.
- Design §1: Datei `state/social-threads/<agentId>/<sessionKey>.json`
  (0600), Shape `{ openTopics: [{ topic, summary, lastTs, awaiting }],
  lastAgentSpeakTs, lastGroupActivityTs, agentAbsentSince }`, openTopics
  cap 3, Update auf der Memory-Extraktions-Cadence, 14-Tage-Expiry.
- Design §2: EINE Kontextzeile über dem Transcript wenn
  `agentAbsentSince > 24 h` ODER ein `awaiting: "agent"`-Topic existiert:
  „You last spoke here <N> days ago. Open threads: …. pick ONE, naturally."
  Guards: nie mehrere Callbacks, nie <24 h, kein Dauer-Befehl.
- Design §5: Rebuild aus observed-Timestamps + memory open_threads.

Neue Dateien: `lib/threads.js`, `state/social-threads/…` (0600/0700).
Config: `threads: { enabled: false, absenceThresholdHours: 24, topicExpiryDays: 14 }`
(default off; Live-Flip ist Operator-Schritt nach Review).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Unit | `node --test test/threads.test.js test/gate.test.js` | all pass |
| Tests | `npm test` | all pass, 0 fail |
| Parity | `node test/parity-matrix.mjs --check` | fully covered, exit 0 |

## Scope

**In scope**:
- `lib/threads.js` (NEU — State-Modell, Load/Flush, Rebuild, API)
- `lib/config.js` + `openclaw.plugin.json` (threads-Block)
- `index.js` (Instanziierung + gateway_stop-Flush)
- `lib/gate.js` (Decide-Injection + onSpeak/onActivity-Hooks)
- `test/threads.test.js` (NEU), `test/gate.test.js` (Injection-Cases)

**Out of scope**:
- Proaktive return_greeting + Thread-Callback-Trigger (Plan 023)
- Die Extraktions-LLM für Topic-Summaries — Quelle sind die
  schemaV2-open_threads aus den Personen-Profilen (Plan 020) +
  observed-Timestamps; KEIN neuer LLM-Call in diesem Plan
- `lib/social-memory.js` (unverändert — Threads liest nur)
- recallCompact-Anpassung: kleine Filter-Ergänzung (open_threads aus dem
  Compact-Recall ENTFERNEN, sobald Thread-Zeile aktiv) — JA in scope,
  minimal (eine Zeile + Test in 021-Manier)

## Git workflow

- Branch: `advisor/022-thread-state`
- 3–4 Commits (Modul, Wiring, Injection, Tests); Stil `plan 022: …`

## Steps

### Step 1: lib/threads.js — State-Modell

```js
export function createThreads({ cfg, stateDir, socialMemory, observedStore, log }) {
  // API: onActivity(sk, agentId, {isOwnReply}), onSpeak(sk, agentId),
  //      contextFor(sk, agentId) → string|null, stop() (flush), __stateForTests
}
```

1. Datei pro Scope: `state/social-threads/<pathSafe(agentId)>/<pathSafe(sessionKey)>.json`
   (pathSafe importieren — scope.js-Export nach Plan 014, sonst lokale
   Kopie NIE; siehe Plan 014-Wartungshinweis). Version-Feld `{ version: 1, … }`
   (Plan-004-Konvention!). 0600-Datei, 0700-Dir, tmp+rename wie
   observed-store.
2. `onActivity`: in-Memory-Cache (Map, cap 512) `lastGroupActivityTs`
   updaten; dirty-flag + 2-s-unref'd Flush (Muster: social-memory.js
   FLUSH_MS — Z. 6-7 + writeProfile Z. 103-112).
3. `onSpeak`: `agentAbsentSince = 0`, `lastAgentSpeakTs = now`, flush.
4. `contextFor(sk, agentId)`:
   - Load-or-Rebuild (Step 2). Decay von `agentAbsentSince`: wird beim
     Flush gesetzt, wenn `>0 && agent seitdem nicht gesprochen`
     (`lastAgentSpeakTs < lastGroupActivityTs`-Logik nach Design §1).
   - Bedingung für die Zeile (Design §2): `agentAbsentSince >
     absenceThresholdHours` ODER ein openTopic mit `awaiting === "agent"`.
   - Rendering (wörtlich am Design §2 orientiert):
     ```
     You last spoke here <N> days ago. Open threads: <topic summaries>.
     A returning member briefly acknowledges the gap or picks up a thread — pick ONE, naturally.
     ```
     N gerundet (1+ Tag); wenn kein Thread: nur die Gap-Zeile ohne
     „Open threads"-Satz; wenn nur Threads (kein Gap >24h): nur Threads.
     Max 3 Topic-Summaries, jede ≤1 Satz.
   - openTopics-Quelle: Personen-Profile des Agents
     (`socialMemory.getOrLoadProfile("<agentId>::" + sk)` — nach Plan 019
     Agent-Store) → alle `open_threads`-Einträge aktiver Personen
     (lastSeen < topicExpiryDays), `awaiting` aus `whoOwesWhat`-Erwähnung
     des Agent-Namens (resolveAgentConfig(...).agentName +
     Aliase, contains-Check, lowercase). topic = t.topic,
     summary = t.lastExchange gekappt auf 1 Satz.
   - 14-Tage-Expiry: Einträge mit `lastTs` älter als topicExpiryDays
     raus (im `contextFor`-Pass, bevor gerendert).
5. `stop()`: flush aller dirty Scopes.

**Verify**: `node --test test/threads.test.js` → pass (Step 4-Tests).

### Step 2: Rebuild (Design §5)

Wenn die Datei fehlt UND der Cache leer ist, beim ersten `contextFor`:

1. `observedStore.readObserved(sk, 200)` → `lastGroupActivityTs` = ts des
   letzten Eintrags; `lastAgentSpeakTs` = ts des letzten Eintrags, dessen
   speaker == Agent-Name (resolveAgentConfig; Alias-tolerant lowercase).
2. `agentAbsentSince` = now - lastAgentSpeakTs falls Agent je sprach,
   sonst 0 (frisch onboardingte Scopes: 0 + wächst von selbst).
3. openTopics kommen aus der Profil-Quelle (Step 1.4) — kein LLM-Rebuild.
4. Ergebnis cachen + flushen (Datei anlegen). Achtung: `readObserved` nach
   Plan 013 gecached — unverändert nutzbar.

**Verify**: Rebuild-Test (Step 4).

### Step 3: Wiring + Decide-Injection

1. `index.js`: `const threads = createThreads({ cfg, engine-independent, stateDir, socialMemory, observedStore, log })`;
   gateway_stop: `threads.stop()`.
2. `lib/gate.js`:
   - createGate erhält `threads` als Dep (wie proactive).
   - `onMessageReceived`: `threads.onActivity(sk, agentId, {})` (nur
     isEnabled + isScopedAgent + isChatSession).
   - `onBeforeAgentReply`: VOR decidePromise:
     ```js
     const threadCtx = threads?.contextFor(sk, ctx?.agentId || agentIdFromSessionKey(sk)) || null;
     ```
     und in den engine.decide-Call als `threadContext` durchreichen.
     `buildDecidePrompt` (local-prompts.js): wenn threadContext → als
     LETZTE Systemzeile vor dem Transcript-Anteil (im systemPrompt, MIT
     wrapUntrusted — es enthält beobachtete Chat-Summary):
     ```js
     if (threadContext) systemLines.push("\n" + UNTRUSTED_DIRECTIVE + "\n" + wrapUntrusted(threadContext));
     ```
   - `applyVerdict` speak: `threads.onSpeak(sk, agentId)`.
   - `markStaySilent`: KEIN onSpeak (Abwesenheit bleibt).
3. naturalize `persistOwnReply`-Pfad: `onSpeak` dort NICHT zusätzlich —
   gate.onSpeak reicht (Reply kommt nach decide-speak; own-Reply-Speak
   ohne gate kann es bei subagent/proactive geben — dort ist Absence
   bewusst irrelevant, siehe Design §3 Anti-Pattern-Note).
4. recallCompact (Plan 021): wenn `threads.contextFor` für den Scope eine
   Zeile liefert, open_threads aus recallCompact rausfiltern — minimal:
   gate entscheidet: `memoryContext` bekommt compact OHNE threads, wenn
   threadContext aktiv (Flag-Param an recallCompact). Ein Zeilen-Hook +
   Test.

**Verify**: `node --test test/gate.test.js` → pass (Injection-Cases Step 4).

### Step 4: Tests

`test/threads.test.js` (NEU; Muster: observed-store.test.js für
Temp-Dirs/0600):

1. Persistenz: onActivity+onSpeak+stop → Datei version 1, 0600, Werte korrekt.
2. Rebuild: Datei löschen → contextFor → lastGroupActivityTs aus
   observed-Fixture, agentAbsentSince berechnet.
3. Zeile nur bei >24 h/awaiting; nie bei frischem Agent-Speak; EXAKT EINE
   Zeile (Guard „pick ONE").
4. 14-Tage-Expiry filtert alte Topics.
5. awaiting-Klassifikation aus whoOwesWhat mit Agent-Name („agent owes"/
   Name contains).
6. gate: Fake-engine fängt decide-Args → threadContext im systemPrompt
   (zwischen Delimitern); ohne Bedingung keine Zeile.
7. threads.enabled:false → contextFor immer null, KEINE Dateien, KEINE
   Injection (Off-Zustand vertragsgetreu).
8. Parity-Rows am Ende: „thread state persists per scope with version +
  rebuild from observed store" + „decide gets ONE bounded absence/thread
  context line when absent >24h or a thread awaits the agent (off by
  default)".

**Verify**: `npm test` → all pass; Parity fully covered.

## Test plan

Siehe Step 4. Kein LLM nötig (alles deterministisch; awaiting via
String-Logik).

## Done criteria

- [ ] `test -f lib/threads.js` und `rg -n "createThreads" index.js lib/gate.js` → Treffer
- [ ] `rg -n '"version": 1' lib/threads.js` → State-Konvention
- [ ] `npm test` exit 0 inkl. threads.test.js; Parity fully covered
- [ ] `plans/README.md` Status-Row aktualisiert

## STOP conditions

- Plan 019/020 nicht gelandet (socialMemory-API ohne Person-Store/open
  _threads) → dieser Plan braucht sie für die Topic-Quelle; dann NUR
  Absence-Tracking (contextFor ohne Topics) bauen und Topics als TODO
  markieren — NEIN: STOP und Report, der Operator entscheidet die
  Reihenfolge.
- Over-Referentialität-Risiko konkret: Injection-Tests zeigen, dass die
  Zeile bei JEDER Decide auftaucht (>1-mal pro Rückkehr) → Guard-Bug →
  STOP mit Repro.
- Die 20-Zeilen-Transcript-Interaktion: threadContext + memoryContext +
  transcript sprengen Prompt-Größe spürbar (>4 KB) → Report mit Messung.

## Maintenance notes

- Operator: `threads.enabled: true` live erst nach Decide-Qualitäts-Review
  (decide-eval-Lauf mit/ohne Zeile; Scripts: scripts/decide-eval-live.mjs).
- Design-Open-Questions §7 (Gap-Verteilung, Schwellen) bleiben messbar:
  state/social-threads liefert die Abwesenheits-Historie — Plan 023 nutzt
  sie für die return_greeting-Kalibrierung.
- agentAbsentSince wächst nur über onActivity/onSpeak-Events — Restart
  Lücken schließt der Rebuild (Zuverlässigkeit von ts in observed ist
  kritisch; Plan 512-Quelle).
- Reviewer-Fokus: (a) Off-default, (b) EINE Zeile, (c) wrapUntrusted, (d)
  0600/0700, (e) keine Namen in Logs (redactSessionKey in threads-Logs!).
