# Plan 009: Speaker-aware Transcript-Dedup — verschiedene Speaker mit gleichem Text dürfen nicht mehr verschwinden

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git -C ~/human-engine diff --stat c4e148b..HEAD -- lib/gate.js test/gate.test.js`
> On mismatch with the "Current state" excerpt: STOP condition.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: MED (Dedup-Key ändert Merge-Output; Plan-529/543-Regressionen müssen grün bleiben)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `c4e148b`, 2026-09-09

## Why this matters

Das Decide-Transkript ist die Grundlage jeder SPEAK/STAY_SILENT-Entscheidung.
Die Dedup-Logik ist speaker-agnostisch: Zwei VERSCHIEDENE Gruppenmitglieder,
die nacheinander denselben kurzen Text schicken („ok", „haha") — oder beide
ein Foto senden (Transkript-Zeile `[image]`) — kollidieren, und die zweite
Zeile wird still verworfen. Der Decide-LLM sieht dann den neuesten Speaker
nicht mehr und entscheidet falsch (falsches stay_silent oder Antwort an die
falsche Person). Live reproduzierbar: Peek `[Bob] ok` + `[Alice] ok` →
Merge-Output enthält nur Bob. Das Plan-543-Ziel (named-First-Wins gegen
anonyme Hydrated-Kopien) muss erhalten bleiben — nur die
Verschiedene-Personen-Kollision wird behoben.

## Current state

`lib/gate.js:71-77` (bei `c4e148b`):

```js
function pushPeekDedup(sk, senderName, text, ts) {
  const peekArr = state.transcriptPeekBySession.get(sk);
  const alreadyPeeked = peekArr && peekArr.length > 0 && peekArr[peekArr.length - 1].endsWith("] " + text);
  if (!alreadyPeeked) {
    pushTranscriptPeek(sk, "[" + senderName + "] " + text, undefined, ts);
  }
}
```

`lib/gate.js:79-102` (mergeTranscriptLayers):

```js
function mergeTranscriptLayers(hydrated, ...layers) {
  const merged = Array.isArray(hydrated) ? [...hydrated] : [];
  const tailIsIncluded = (line) => {
    const tail = String(line.text || "").slice(-200);
    return merged.some((m) => String(m.text || "").endsWith(tail));
  };
  for (const layer of layers) { /* ... push bei !tailIsIncluded(entry) ... */ }
  const tsOf = (x) => (typeof x?.ts === "number" ? x.ts : Infinity);
  merged.sort((a, b) => tsOf(a) - tsOf(b));
  return merged.slice(-20);
}
```

Aufruf (gate.js:118): `return mergeTranscriptLayers(observed, peek, hydrated, current);`
— d.h. Param `hydrated` = observed-Array (Layer 0, named), layers = [peek,
hydrated-SDK, current]. Die aktuelle Zeile ist `current` (einzelnes Objekt).

Plan-543-Semantik (Wiki quickstart): „Layers merge named-first (observed →
peek → hydrated → current): the dedup is first-wins and speaker-agnostic, so
the named copy must win over the hydrated generic-[User] copy". Die
gleiche Nachricht erscheint also in mehreren Layern mit UNTERSCHIEDLICHEN
Speaker-Labels (named vs „User") — Cross-Layer-Dedup MUSS speaker-agnostisch
bleiben. Die Kollision VERSCHIEDENER Nachrichten (verschiedene Speaker,
gleicher Text) ist der Bug.

Konventionen: Log-Präfix `human-engine:`; Tests inline fakes in
`test/gate.test.js` (Merge-Tests um `mergeTranscriptLayers`-Fälle,
grep „dedup"/„named"); Parity-Matrix ist Release-Vertrag.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Unit | `node --test test/gate.test.js` | all pass |
| Tests | `npm test` | all pass, 0 fail |
| Parity | `node test/parity-matrix.mjs --check` | fully covered, exit 0 |

## Scope

**In scope**:
- `lib/gate.js` (nur `pushPeekDedup` + `mergeTranscriptLayers`)
- `test/gate.test.js` (neue Cases)
- `test/parity-matrix.mjs` (eine neue Row, am Ende anhängen)

**Out of scope**:
- `lib/state.js` (pushTranscriptPeek bleibt unverändert)
- `lib/naturalize.js` persistOwnReply (dessen 300-Zeichen-Schnitt ist mit
  peek-Text identisch — Cross-Layer-Dedup greift weiter, siehe Maintenance)
- Reihenfolge/Slice(-20) der Merge-Logik — nur der Dedup-Key ändert sich

## Git workflow

- Branch: `advisor/009-speaker-aware-dedup`
- 1–2 Commits; Stil `plan 009: …`

## Steps

### Step 1: pushPeekDedup auf volle Zeile vergleichen

Ersetze den Suffix-Vergleich durch exakte Gleichheit der letzten Peek-Zeile
(gleiche Nachricht ⇒ gleicher Speaker + gleicher Text):

```js
const last = peekArr && peekArr.length > 0 ? peekArr[peekArr.length - 1] : null;
const alreadyPeeked = last === "[" + senderName + "] " + text;
```

Damit sind `"[A] [image]"` und `"[B] [image]"` keine Duplikate mehr
(unterschiedliche Speaker-Präfixe), während das echte Double-Push derselben
Nachricht (message_received + before_agent_reply) weiterhin gefiltert wird.

**Verify**: `node --test test/gate.test.js` → pass (bestehende Tests; neue
Cases in Step 3).

### Step 2: mergeTranscriptLayers — zweistufiger Dedup-Key

Dedup bleibt speaker-agnostisch NUR wenn eine Seite anonym ist (Plan-543:
named schlägt `[User]`/leer). Zwei benannte, verschiedene Speaker dedupen
NIE mehr. Implementiere:

```js
function isAnonymous(speaker) {
  const s = String(speaker || "").trim();
  return s === "" || s.toLowerCase() === "user";
}
// in tailIsIncluded:
const tail = String(line.text || "").slice(-200);
const sp = String(line.speaker || "");
return merged.some((m) => {
  const mSp = String(m.speaker || "");
  const tailMatch = String(m.text || "").endsWith(tail);
  if (!tailMatch) return false;
  if (isAnonymous(mSp) || isAnonymous(sp)) return true;  // Cross-Layer named-vs-generic (Plan 543)
  return mSp === sp;                                       // gleiche Person, gleicher Text
});
```

Bekannter, dokumentierter Rest: dieselbe Person schickt zweimal „ok"
(z.B. observed-Layer + current) → wird weiter dedupet (Voralter Zustand,
deutlich seltener als der behobene Fall). Als Kommentar im Code festhalten.

**Verify**: `node --test test/gate.test.js` → pass; danach `npm test`.

### Step 3: Tests

In `test/gate.test.js` (Muster: bestehende mergeTranscriptLayers-Tests):

1. `[A] ok` (observed) + `[B] ok` (current) → BEIDE Zeilen im Merge-Output.
2. `[A] [image]` (observed) + `[B] [image]` (current) → beide überleben
   (Media-Marker-Kollision).
3. Plan-543-Anker: named observed `[Kevin] ok` + hydrated anonym `[User] ok`
   → NUR eine Zeile, Speaker „Kevin" (named-first unverändert).
4. Gleiche Nachricht in peek + current (gleicher Speaker, gleicher Text)
   → nur eine Zeile (Dedup funktioniert weiter).
5. pushPeekDedup: Zeile `[A] [image]` als letzte Peek-Zeile, dann Push
   `[B] [image]` → wird NICHT gefiltert (wird gepusht).

Parity-Matrix: neue Row am Ende (z.B. „transcript dedup is
speaker-aware: distinct speakers with identical text or media markers are
never collapsed; anonymous-vs-named cross-layer dedup (Plan 543) preserved"),
Tag = Substring der neuen Testnamen.

**Verify**: `npm test` → all pass; `node test/parity-matrix.mjs --check`
→ fully covered, exit 0.

## Test plan

Siehe Step 3. Die bestehenden Plan-529/543/545-Tests (chronologische
Stabilität, named-first, FIFO) sind der Regressions-Anker und MÜSSEN grün
bleiben.

## Done criteria

- [ ] `npm test` exit 0 inkl. neuer Cases; Parity fully covered
- [ ] `grep -n "endsWith(\"] \" + text)" lib/gate.js` → kein Treffer
- [ ] `git status` nur In-Scope-Dateien
- [ ] `plans/README.md` Status-Row aktualisiert

## STOP conditions

- Die gate.js-Zitate bei `c4e148b` passen nicht (Code gedriftet).
- Ein bestehender Plan-529/543-Test bricht inhaltlich (nicht nur Setup-Rauschen)
  → melden, nicht „fixen".
- Die Fix-Richtung erfordert Änderungen an state.js/naturalize.js (out of scope).

## Maintenance notes

- Persistierte eigene Replies (naturalize.js persistOwnReply, Plan 528)
  nutzen dieselbe `[Name] text`-Form; das neue Schema kann sie sauber von
  Mitglieder-Zeilen unterscheiden — bei künftigen Merge-Änderungen nutzen.
- Reviewer-Fokus: (a) Plan-543-Cases bleiben grün, (b) keine neue
  Duplikat-Zeile im Cross-Layer-Fall, (c) Kommentar über den
  dokumentierten Same-Person-Restfall ist im Code.
- Plan 024 (Decide-Contract) baut auf diesem sauberen Transkript auf.
