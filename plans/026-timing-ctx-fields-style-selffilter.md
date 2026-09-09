# Plan 026: Timing-CTX-Felder + Style-Selbstfilter — tote Human-Timing-Features aktivieren, Eigenkontamination der Style-Stats beenden

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git -C ~/human-engine diff --stat c4e148b..HEAD -- lib/local-engine.js lib/timing-engine.js lib/naturalize.js lib/persona.js lib/state.js test/timing-engine.test.js test/gate.test.js`
> On mismatch mit den "Current state" excerpts: STOP condition.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: LOW (Timing-Verteilung verschiebt sich leicht — Distribution-Tests prüfen Grenzen; Style-Filter ändert die Constraint-Quelle)
- **Depends on**: none
- **Category**: bug / direction
- **Planned at**: commit `c4e148b`, 2026-09-09

## Why this matters

Zwei gebaute Human-Features feuern produktiv nie, und ein Messfehler
verzerrt die Style-Constraints:

1. `readingDelayMs` kennt `hourOfDay` (Night-Mode ×1.4) und `wasAddressed`
   (×0.6) — aber der EINZIGE Produktions-Caller setzt NEIN von beiden
   (nur Tests). 3 Uhr nachts = gleiche Reaktionszeit wie 15 Uhr; eine
   direkte Namensansprache (hard trigger) wird nicht schneller beantwortet
   als Side-Chatter.
2. `computeStyleStats` läuft über den Transcript-Peek INKLUSIVE der
   eigenen Replies — der Agent lernt seinen eigenen Output als
   „Gruppen-Stil" zurück und driftet selbstverstärkend.

## Current state

`lib/local-engine.js:156-163` (respond — der einzige scheduleForBubbles-Caller):

```js
const timingCfg = cfg?.timing || {};
const ctx = {
  isGroup: isGroup === true,
  isQuestionReply: Boolean(triggerInfo?.replyTarget?.quotedName),
  contentReadMs: estimateReadMs(triggerInfo, transcript),
};
const scheduled = timing.scheduleForBubbles(bubbles, ctx, timingCfg);
```

`lib/timing-engine.js:29-41`:

```js
const isQuestionReply = c.isQuestionReply === true || c.wasAddressed === true;
if (isQuestionReply) d *= 0.6;
else if (c.isGroup) d *= 1.5;
if (c.contentReadMs) d += c.contentReadMs;
if (nightMode && c.hourOfDay != null && (c.hourOfDay >= 22 || c.hourOfDay < 7)) d *= 1.4;
```

`lib/persona.js:48-54` (buildPersonaPrompt — Style-Stats über den vollen Peek):

```js
if (cfg.styleStats !== false && sessionKey) {
  const peek = transcriptPeekBySession.get(sessionKey);
  if (peek && peek.length >= 10) {
    const stats = computeStyleStats(peek);
    const constraint = styleConstraintText(stats);
    if (constraint) parts.push(constraint);
  }
}
```

Peek enthält eigene Zeilen: naturalize.js:230
`pushTranscriptPeek(sk, "[" + agentName + "] " + text.slice(0, 300), …)` und
gate.js:177. computeStyleStats (style-stats.js:10) stript nur das
`[speaker]`-Präfix, filtert niemanden.

Der Gate KENNT den Trigger-Pfad bereits: applyVerdict/shared.path
("dm" | "reply" | "hard" | "llm") — aber wirft ihn weg. naturalize baut
triggerInfo selbst (naturalize.js:354-360) aus replyTarget — der Pfad fehlt.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Unit | `node --test test/timing-engine.test.js test/timing-distribution.test.js test/naturalize.test.js test/persona.test.js` | all pass |
| Tests | `npm test` | all pass, 0 fail |
| Parity | `node test/parity-matrix.mjs --check` | fully covered, exit 0 |

## Scope

**In scope**:
- `lib/local-engine.js` (respond: ctx.hourOfDay + ctx.wasAddressed)
- `lib/naturalize.js` (triggerInfo.wasAddressed aus speak-path)
- `lib/state.js` (NEU: `speakPathBySession` Map — klein, cap wie üblich)
- `lib/gate.js` (markSpeak/applyVerdict: speak-path stashen; EINE Zeile)
- `lib/persona.js` (Style-Stats: eigene Zeilen filtern)
- `test/timing-engine.test.js`, `test/persona.test.js`, `test/naturalize.test.js` (Cases)

**Out of scope**:
- timing-engine.js selbst (Parameter existieren und sind getestet — nur
  der Caller versorgt sie)
- Timing-Config-Werte (typingWpm, nightMode-Flag)
- mood.js (eigenes Timing-Thema: Plan 030)

## Git workflow

- Branch: `advisor/026-timing-ctx-style-filter`
- 2 Commits (Timing-Teil, Style-Teil); Stil `plan 026: …`

## Steps

### Step 1: speak-path stashen (gate)

1. `lib/state.js`: `export const speakPathBySession = new Map();`
2. `lib/gate.js` in `markSpeak(sk, agentId, senderName, epoch, agentName)`
   — dort fehlt der path; ergänze ihn als Parameter vom applyVerdict-Call
   (`markSpeak(..., shared.path)`) UND den dedup-Zweigen (Z. 326) —
   `state.speakPathBySession.set(sk, path); capMap(state.speakPathBySession, 4096);`
   Bei epoch-null-Pfaden (dm/hard/reply) ist path bekannt; alle
   applyVerdict-Zweige liefern ihn.

**Verify**: `node --test test/gate.test.js` → pass.

### Step 2: respond-ctx füttern (naturalize + local-engine)

1. `lib/naturalize.js` flush (Z. ~356-360, triggerInfo-Bau):
   ```js
   const speakPath = state.speakPathBySession.get(sk) || null;
   const triggerInfo = {
     replyTarget: replyTarget ?? null,
     newestAgeMs: …, triggerLen: …,
     wasAddressed: speakPath === "dm" || speakPath === "reply" || speakPath === "hard",
   };
   ```
   (state.speakPathBySession NICHT löschen — der nächste Flush braucht
   ihn; markComplete-Ende könnte clearen — minimal: nicht clearen, cap
   reicht.)
2. `lib/local-engine.js` respond:
   ```js
   const ctx = {
     isGroup: isGroup === true,
     isQuestionReply: Boolean(triggerInfo?.replyTarget?.quotedName),
     wasAddressed: triggerInfo?.wasAddressed === true,
     contentReadMs: estimateReadMs(triggerInfo, transcript),
     hourOfDay: new Date().getHours(),
   };
   ```

**Verify**: `node --test test/naturalize.test.js test/local-engine.test.js` → pass.

### Step 3: Style-Stats filtern (persona)

In `lib/persona.js` buildPersonaPrompt — vor computeStyleStats:

```js
const ownNames = new Set([String(cfg.agentName || ""), ...(cfg.agentAliases || [])]
  .map((n) => String(n).toLowerCase()).filter(Boolean));
const peek = (transcriptPeekBySession.get(sessionKey) || [])
  .filter((line) => {
    const m = /^\[([^\]]*)\]/.exec(line);
    return !m || !ownNames.has(m[1].trim().toLowerCase());
  });
```

(cfg ist hier der aufgelöste agentCfg — buildPersonaPrompt(cfg, sessionKey,
agentId) erhält aus gate.js bereits resolveAgentConfigForSession-Output.
Verifizieren: naturalize.js:323 + gate.js:236 rufen mit agentCfg.)

**Verify**: `node --test test/persona.test.js` → pass (neue Cases Step 4).

### Step 4: Tests

1. timing: respond-Resultat enthält bei `wasAddressed:true` kürzere
   Erst-Bubble-Delay als ohne (RNG fixieren via setRng — Muster in
   timing-distribution.test.js). Night: hourOfDay=3 vs 14 (RNG fix).
2. naturalize: Fake-engine fängt respond-Args → triggerInfo.wasAddressed
   true bei speak-path "hard", false bei "llm" (ohne replyTarget).
3. gate: speak-Pfad landet in speakPathBySession (Fake-engine path:"hard").
4. persona: Peek mit `[Yuki] …`-Zeilen + Mitglieder-Zeilen → constraint
   beschreibt NUR Mitglieder-Raten (z.B. eigene Emoji-Zeile verschiebt
   emojiRate NICHT).
5. Distribution-Grenzen: clamp-Tests bleiben grün (2000–30000 ms).
6. Parity-Row: „production timing sets hourOfDay + wasAddressed (night
  mode and direct-address fast-path active); style stats exclude the
  agent's own lines".

**Verify**: `npm test` → all pass; Parity fully covered.

## Test plan

Siehe Step 4. RNG-Fixierung: setRng/resetRng aus timing-engine.js
(bestehendes Muster).

## Done criteria

- [ ] `rg -n "hourOfDay" lib/local-engine.js` → Treffer (Caller versorgt)
- [ ] `rg -n "speakPathBySession" lib/state.js lib/gate.js lib/naturalize.js` → Treffer
- [ ] `rg -n "ownNames" lib/persona.js` → Treffer
- [ ] `npm test` exit 0; Parity fully covered
- [ ] `plans/README.md` Status-Row aktualisiert

## STOP conditions

- applyVerdict-Zweige (incl. dedup) lassen sich nicht ohne Verhaltensänderung
  um den path-Parameter erweitern → Report (dann path über state statt
  Param — Design-Entscheidung).
- Distribution-Tests brechen SYSTEMATISCH (nicht nur Grenzfälle) → Report
  mit den zwei konkreten Zahlen vor/nach.

## Maintenance notes

- Live-Effekt beobachtbar: „respond … delays=…"-Log-Zeilen im
  Gateway-Log — nachts höher, direkte Ansprache schneller. Nach 48 h
  Review ob sich die Gruppe „richtiger" anfühlt.
- speakPathBySession ist auch die Datenbasis für künftiges
  Decide-Qualitäts-Tuning (path-Verteilung loggen).
- Style-Filter: Wenn künftig ein Agent bewusst SEINEN Stil spiegeln will
  (Plan 031 Self-Voice), bekommt der einen EIGENEN Stats-Lauf — dieser
  Filter hier bleibt.
