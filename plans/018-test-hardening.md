# Plan 018: Test-Härtung — TTS-Retry, onSilence-E2E-Wiring, schwache Assertions, Parity-Bools

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git -C ~/human-engine diff --stat c4e148b..HEAD -- lib/naturalize.js test/naturalize.test.js test/e2e-local.test.js test/gate.test.js test/mood.test.js test/parity-matrix.mjs`
> On mismatch with den "Current state" excerpts: STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW-MED (ein kleiner Produktions-Rechtleich für Testbarkeit; Rest rein testseitig)
- **Depends on**: none (nach 009 ideal, aber unabhängig ausführbar)
- **Category**: tests
- **Planned at**: commit `c4e148b`, 2026-09-09

## Why this matters

Drei Release-Vertragslücken: (1) Das Plan-548b-TTS-Bubble-Feature (HART:
„never voice-only, never lost on host reject") hat NULL Tests —
`deliverWithRetry`'s Media→Text-Retry ist genau der Pfad, der verhindern
soll, dass Replies verloren gehen. (2) Der Plan-545-Incident (still
verlorene Reply bei silence) ist nur in Isolation getestet — das
PRODUKTIONS-Wiring gate.onSilence → naturalize (index.js:117) ist in
keinem einzigen Test verbunden. (3) Einzelne Assertions sind tautologisch
(`assert.ok(true)`), und die Parity-Matrix kann nicht zwischen echten
Verhaltens-Rows und schwachen Rows unterscheiden.

## Current state

`lib/naturalize.js:69-86` (deliverWithRetry — Modul-privat, ungetestet):

```js
async function deliverWithRetry(dispatcher, content, ttsCtx, log) {
  const payload = await applyTtsToDraft({ text: content }, ttsCtx, log);
  let ok;
  try { ok = dispatcher.sendBlockReply(payload); } catch { ok = false; }
  if (ok === false) {
    // Host rejected the (possibly media-carrying) payload — retry text-only so the reply is never lost.
    try { ok = dispatcher.sendBlockReply({ text: content }); } catch { ok = false; }
  }
  return ok;
}
```

Wiring: `index.js:117` → `createGate({ …, onSilence: naturalize.onSilence })`;
gate.js:130-131 ruft `onSilence(sk)` nur bei stay_silent.
`test/naturalize.test.js:911,929,962` testet onSilence direkt.
`test/gate.test.js:118` → `assert.ok(true)` (missing-sessionKey-Case).
`test/parity-matrix.mjs` Rows sind `{ id, behavior, tags }`-Objekte;
`--check` matched nur Testnamen-Substrings.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Unit | `node --test test/naturalize.test.js test/e2e-local.test.js test/gate.test.js` | all pass |
| Tests | `npm test` | all pass, 0 fail |
| Parity | `node test/parity-matrix.mjs --check` | fully covered, exit 0 |

## Scope

**In scope**:
- `lib/naturalize.js` (NUR: deliverWithRetry exportieren — kein Verhalten ändern)
- `test/naturalize.test.js`, `test/e2e-local.test.js`, `test/gate.test.js`,
  `test/mood.test.js`, `test/social-memory.test.js` (Assertion-Härtungen)
- `test/parity-matrix.mjs` (`kind`-Feld pro Row + Check-Warnung)

**Out of scope**:
- TTS-Runtime-Mock des SDK (applyTtsToDraft-INTERN ist per lazy-import —
  wir testen deliverWithRetry MIT einem Fake-Payload, nicht das SDK)
- Produktionscode-Änderungen über den Export hinaus
- Neue Parity-Rows für Features (andere Pläne machen das)

## Git workflow

- Branch: `advisor/018-test-hardening`
- 2–3 Commits; Stil `plan 018: …`

## Steps

### Step 1: deliverWithRetry exportieren

In `lib/naturalize.js`: `async function deliverWithRetry` → `export async
function deliverWithRetry` (kein anderes Delta). Falls es am Modul-Ende
eine Export-Sektion gibt, dort ergänzen; die Funktion bleibt am Ort.

**Verify**: `node -e "import('./lib/naturalize.js').then(m => assert.ok(typeof m.deliverWithRetry === 'function'))"` → exit 0.

### Step 2: TTS-Retry-Test

`test/naturalize.test.js` — neuer Case (Muster: bestehende
Dispatcher-Fake-Tests):

1. Fake-dispatcher: `sendBlockReply` returned `false` wenn payload
   `mediaUrl` hat, `true` für `{ text }`.
2. Aufruf `deliverWithRetry(dispatcher, "antwort", ttsCtxFake, log)` —
   ttsCtxFake so, dass `applyTtsToDraft` ohne SDK ein media-Payload
   simuliert? Achtung: applyTtsToDraft ohne SDK-Applier returned das
   Payload unverändert ({text}). DIREKTER Test daher auf der Retry-Semantik:
   rufe deliverWithRetry mit einem Payload, der media trägt — da
   applyTtsToDraft das nicht injiziert ohne SDK, testest du den Retry
   stattdessen so: Fake-Dispatcher returned false auf den ERSTEN Call
   (egal welcher Payload) und true auf den zweiten → assert: zweiter Call
   hatte `{ text: "antwort" }` (text-only), Rückgabe `true`.
3. Beide-Calls-fail → Rückgabe `false` (RAW REPLY LOST-Pfad ist bewusst
   Log-only — assert Rückgabe false + Log-Warn-Fake erhielt einen Call).

**Verify**: `node --test test/naturalize.test.js` → pass.

### Step 3: onSilence-Wiring-E2E

`test/e2e-local.test.js` — neuer Case (Muster: bestehende
Gate+Naturalize-Paar-Tests in dieser Datei):

1. Echte `createGate` + `createNaturalize`-Instanzen verdrahtet wie
   index.js:117 (`onSilence: naturalize.onSilence`).
2. Fake-Engine → speak; zwei Dispatcher armen (zwei reply_dispatch-Ereignisse),
   erster wird durch reply_payload_sending + Flush konsumiert (Draft in
   Flight), zweiter bleibt unconsumed.
3. Nun ein inbound message → gate entscheidet stay_silent (Fake-Engine).
4. Assert: unconsumed Dispatcher #2 → `markComplete` called; consumed #1
   NICHT completed (dessen Reply lief); in-memory Queue leer.
5. Assert-Reihenfolge egal — nur die Endzustände.

**Verify**: `node --test test/e2e-local.test.js` → pass (echte Timer:
FLUSH_DEBOUNCE 1200 ms — bestehende Suite schläft schon 1,5 s; reuse Muster,
keine neuen sleep-Anti-Patterns).

### Step 4: Assertion-Härtungen

1. `test/gate.test.js:118` `assert.ok(true)` → echte Assertion: Handler
   returned `undefined` und wirft nicht (missing sessionKey).
2. `test/mood.test.js` Injection-Case → zusätzlich assert, dass der
   appendSystemContext-String `valence -1`/`energy 1`-Werte enthält
   (renderInjection rendert Achsen).
3. `test/social-memory.test.js` Eviction-Test (~Z. 406-424): wenn er nur
   dokumentiert, dass Eviction NICHT beim ingest passiert, ergänze einen
   echten extract-Pfad-Case (maxPeople-1 Profil + extract + LLM-Return →
   ältester lastSeenTs wird gedroppt). Nur wenn in vertretbarer Zeit —
   sonst Kommentar-Präzisierung und TODO lassen, KEINE Fake-Assertion.

**Verify**: `node --test test/gate.test.js test/mood.test.js test/social-memory.test.js` → pass.

### Step 5: Parity-Matrix `kind`-Feld

1. Jeder Row ein optionales `kind: "behavioral" | "static"` geben
   (Default `"behavioral"`). Klassifiziere ehrlich: Rows, die nur
   Config-Werte/Log-Zeilen/Statik prüfen (z.B. Zeilen 13-16, 20, 26, 30,
   17, 31 — nach eigener Lektüre verifizieren), → `"static"`.
2. `--check` printed am Ende: `static rows: N (review recommended)` —
   Warnung, KEIN Failure (Abwärtskompatibilität; Hardening später).

**Verify**: `node test/parity-matrix.mjs --check` → fully covered, exit 0,
static-Count-Zeile sichtbar. `npm test` → all pass.

## Test plan

Siehe Steps 2-5. Anker: bestehende naturalize/e2e-Fakes.

## Done criteria

- [ ] `rg -n "assert.ok\(true\)" test/` → leer
- [ ] `rg -n "deliverWithRetry" test/naturalize.test.js` → ≥2 Cases
- [ ] E2E-Case onSilence-Wiring existiert (grep onSilence in e2e-local.test.js)
- [ ] `npm test` exit 0; Parity fully covered + kind-Feld
- [ ] `plans/README.md` Status-Row aktualisiert

## STOP conditions

- Der e2e-Case braucht >4 s Laufzeit oder wird flaky (zwei Durchläufe
  hintereinander prüfen) → auf Fake-Timer umstellen oder Report.
- Eine „Härtung" würde einen bestehenden Test-Intent ändern → Report statt
  Anpassung.
- parity-matrix Row-Klassifikation ist mehrdeutig (Row beschreibt
  Verhalten, das nur via Log prüfbar ist) → als behavioral belassen +
  Kommentar, keine Blockade.

## Maintenance notes

- Reviewer der nächsten Wellen: `kind: "static"`-Rows sind
  Review-Empfehlung, kein Vertrag — neue Rows immer behavioral anlegen,
  wo möglich.
- Der deliverWithRetry-Export ist bewusst minimal — falls künftig TTS
  SDK-mockbar wird, applyTtsToDraft-e2e nachziehen.
