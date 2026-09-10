# Plan 034: Media-Kontext in den Decide — Caption-in-Transcript, Capture-Gap-Fix, kind-gewichtete Lesezeit

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. SKIP the plans/README.md update (reviewer
> maintains the index).
>
> **Drift check (run first)**: compare the "Current state" excerpts against
> LIVE code; apply intent, STOP only on semantic contradiction.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: LOW (Prompt-Shaping ohne neue LLM-Calls; Persist-Pfad-Erweiterung fail-open)
- **Depends on**: none (basis: Wave-2-Endstand inkl. 026 timing-ctx)
- **Category**: direction
- **Planned at**: 2026-09-10

## Why this matters

Fotos/Voice-Notes erscheinen dem Decide als inhaltsleerer Marker `[image]` —
der Agent kann auf Medien nur raten. Der Spike (plans/025-media-caption-spike-report.md)
fand: (1) Captions kommen im `cleanedBody` an (Host faltet sie in den Body;
Media-Facts haben KEIN caption-Feld) — die Caption erreicht den Decide-Prompt
also bereits als Text, aber die Transcript-Zeile zeigt sie nicht im
Media-Kontext; (2) media-only Nachrichten (ohne Caption → leerer Body) werden
vom observed store GEDROPPPT (`appendObserved` skippt leere Texte) — Capture-
Gap: Medienvolumen ist nicht messbar und Threads/Memory sehen sie nie;
(3) `estimateReadMs` addiert pauschal 1500 ms für JEDE Media-Art.
Dieser Plan schließt alle drei Lücken ohne einen einzigen neuen LLM-Call.

## Current state

- `lib/gate.js` `resolveTranscript` (~Z. 129-131): media-only + leerer Body →
  `current.text = media.marker`. Bei vorhandenem Body bleibt `current.text`
  der nackte Body (kein Media-Kontext in der Zeile).
- `lib/gate.js` `onBeforeAgentReply`: `displayText = prompt || (cachedMedia?.marker …)`
  existiert bereits (~Z. 227) und wird für pushPeekDedup genutzt — aber
  `markStaySilent(sk, senderName, prompt, …)` bekommt `prompt` (bei
  media-only leer) → `persist()`/`pushObserved` skippen den Row
  (observed-store.js:39 `if (!row.text) return;`).
- `lib/local-engine.js` `estimateReadMs` (~Z. 136-141): flat `ms += 1500`
  bei jedem Media-Marker in der Transcript (TriggerLen-Logik davor bleibt).
- Report-Report-Fund: Gate-Marker-Map (`lib/gate.js` SDK_KIND_TO_PLACEHOLDER)
  vs `lib/messages.js` MEDIA_PLACEHOLDERS — Duplikat, bewusst OUT OF SCOPE.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Unit | `node --test test/gate.test.js test/local-engine.test.js test/observed-store.test.js` | all pass |
| Tests | `npm test` | all pass, 0 fail |
| Parity | `node test/parity-matrix.mjs --check` | fully covered, exit 0 |

## Scope

**In scope**:
- `lib/gate.js` (Transcript-Zeile mit Caption; displayText in markStaySilent-Aufrufen)
- `lib/local-engine.js` (estimateReadMs kind-gewichtet)
- Tests der drei Module + `test/parity-matrix.mjs` (eine Row)

**Out of scope**:
- Vision-/Transkriptions-Pipeline (bewusst NICHT — Report-Empfehlung)
- `lib/messages.js` Marker-Unifikation (notiert, eigener Hygiene-Slot)
- TTS (Plan 548b), Config-Änderungen

## Git workflow

- Branch: `advisor/034-media-context`; Commits `plan 034: …`

## Steps

### Step 1: Caption in die Transcript-Zeile

In `resolveTranscript`: `current.text` bei Media = `marker` + (Body nicht-leer
? `" " + Body` : ``) — also `[image] Strandtag heute` als Zeilentext (Speaker-
Präfix bleibt `[Kevin] …`). Body-leer → nur Marker (Status quo). Dasselbe
Muster für `displayText` in `onBeforeAgentReply` ist bereits vorhanden
(pushPeekDedup-Pfad) — verifizieren, nicht doppelt bauen.

**Verify**: `node --test test/gate.test.js` → pass (Case Step 4).

### Step 2: Capture-Gap — media-only persistieren

In `onBeforeAgentReply`: alle drei `markStaySilent`-Aufrufe (Hauptpfad,
burst-dedup, engine-null group-fail-closed) bekommen statt `prompt` das
bereits berechnete `displayText` (marker-fallback inklusive). Dadurch
persistiert eine stille Media-only-Nachricht als `[Speaker] [image]`-Row im
observed store (Volumen messbar, Threads/Memory sehen das Ereignis).
`markStaySilent`-Signatur UND der decide-Prompt-`prompt`-Parameter bleiben
nicht-leer-Logik unverändert (leerer prompt im Engine-Call bleibt leer —
nur die Persistenz nutzt displayText).

**Verify**: `node --test test/gate.test.js test/observed-store.test.js` → pass.

### Step 3: estimateReadMs kind-gewichtet

Map statt flat 1500 (Konstanten lokal, config-frei):

```js
const MEDIA_READ_MS = { image: 2500, video: 4000, voice: 1500, audio: 1500, document: 2000, sticker: 800, unknown: 1500 };
// ms += MEDIA_READ_MS[kind] ?? 1500 — kind aus dem Marker-Text der Zeile extrahieren (bestehender mediaMarkerRe → kind-Gruppe)
```

Der mediaMarkerRe matcht bisher nur ja/nein — erweitern auf
`(image|video|voice message|audio|document|sticker)` und auf die
MEDIA_READ_MS-Schlüssel mappen (`voice message` → voice).

**Verify**: `node --test test/local-engine.test.js` → pass.

### Step 4: Tests + Parity

1. Transcript: Media+Caption → `[Kevin] [image] Strandtag heute` als letzte
   Zeile; Media ohne Caption → `[Kevin] [image]`.
2. markStaySilent media-only: observed-store-Fake erhält Row mit
   `[image]`-Text (Capture-Gap geschlossen); Bestehende stay_silent-Tests
   bleiben grün (Text-Pfad unverändert).
3. estimateReadMs: image 2500, sticker 800, unbekannt 1500; TriggerLen-Logik
   unangetastet.
4. Parity-Row am Ende: „media context: transcript carries marker+caption,
  silent media-only messages persist to the observed store, read time is
  kind-weighted".

**Verify**: `npm test` → all pass; Parity fully covered.

## Test plan

Siehe Step 4. Anker: bestehende gate-Transcript-Tests (Plan 009 speaker-aware
Dedup darf NICHT brechen — Caption-Zeilen sind einzigartig, kein
Dedup-Kollisionsrisiko).

## Done criteria

- [ ] `rg -n "MEDIA_READ_MS" lib/local-engine.js` → Def + Use
- [ ] `rg -n "displayText" lib/gate.js` → auch in markStaySilent-Aufrufen
- [ ] `npm test` exit 0; Parity fully covered
- [ ] plans/README.md (vom Reviewer)

## STOP conditions

- Ein Plan-009-Dedup-Test bricht durch die Caption-Zeilen → STOP (das wäre
  eine unvorhergesehene Dedup-Interaktion).
- Der inbound-Body enthält bei captioned Media NICHT die Caption (Host-
  Verhalten anders als im Report dokumentiert) → STOP mit Live-Beweis
  (Gateway-Log-Zeile, PII-safe gekürzt).

## Maintenance notes

- Live-Beobachtung: decide-ctx zeigt jetzt Caption-Kontext; wenn der Agent
  auf Fotos überreagiert → Decide-Prompt-Media-Zeile (local-prompts) nach-
  schärfen (ein Satz), KEINE neue Mechanik.
- Vision-Pipeline bleibt verworfen (Report 025: +1 LLM-Call/Media, Latenz im
  Decide-Pfad) — erst nach Host-seitigem Live-Check (Report §5) revisitieren.
