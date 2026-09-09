# Plan 027: detectTells-Runtime-Backstop — Anti-Tell wird von Prompt-Wunsch zur Auslieferungs-Prüfung

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git -C ~/human-engine diff --stat c4e148b..HEAD -- lib/anti-tell.js lib/naturalize.js test/anti-tell.test.js test/naturalize.test.js`
> On mismatch mit den "Current state" excerpts: STOP condition.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW (fail-open wie stripMetaCommentary; Sanitizer greift nur mechanische Tells)
- **Depends on**: none
- **Category**: bug / direction
- **Planned at**: commit `c4e148b`, 2026-09-09

## Why this matters

`detectTells` (anti-tell.js:29-59) erkennt Em-Dash, Markdown, Banned-Lexicon,
„It's not X, it's Y", Summary-Closings — aber NUR Tests importieren es. Im
Produktions-Delivery-Pfad gibt es ausschließlich `stripMetaCommentary`; die
Anti-Tell-Regeln sind reine Prompt-Bitten (ANTI_TELL_BLOCK). Wenn das
Split-/Humanize-LLM regrediert (Modellwechsel, Temperature 0.9), landen
Tells unkontrolliert in der Gruppe — die „fühlt sich wie ein Bot"-
Signale, die der Owner am wenigsten will. Dieser Plan macht die
mechanischen Tells zur Runtime-Prüfung pro Bubble: sanitizen statt
blockieren (Antwort geht nie verloren), Log-Warn mit Zähler für
Modell-Regression-Beobachtung.

## Current state

`lib/anti-tell.js:29-59` — detectTells (exportiert, ungenutzt in lib/):

```js
export function detectTells(text) {
  const tells = [];
  if (text.includes("\u2014")) tells.push("em-dash");
  if (/^(?:[\s]*[-*+]\s|\s*\d+[.)]\s)/m.test(text)) tells.push("list");
  if (text.includes("**")) tells.push("bold-markdown");
  if (/^#+\s/m.test(text)) tells.push("header");
  for (const word of BANNED_LEXICON) { if (new RegExp("\\b" + word + "\\b", "i").test(text)) tells.push("banned-word:" + word); }
  if (/It'?s\s+not\s+.+?,?\s+it'?s\s+/i.test(text)) tells.push("its-not-its");
  if (/Not only[\s\S]{0,30}but also/i.test(text)) tells.push("not-only-but-also");
  if (/\b(In conclusion|To summarize|Overall)[,\s]/i.test(text)) tells.push("summary-closing");
  if (/\b(Firstly|Secondly|Thirdly|Moreover)\b/i.test(text)) tells.push("enumeration");
  if (/^Certainly!/m.test(text)) tells.push("certainly-exclamation");
  if (/How can I help you\?/i.test(text)) tells.push("customer-service");
  return tells;
}
```

`lib/naturalize.js` flush: nur stripMetaCommentary (Z. 3, :309-313).
Bubbles werden geplant (respondResult.scheduled) und im Timer-Loop
zugestellt (Z. ~401-426). `stripMetaCommentary` ist das
Fail-open-Vorbild: niemals werfen, nur loggen.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Unit | `node --test test/anti-tell.test.js test/naturalize.test.js` | all pass |
| Tests | `npm test` | all pass, 0 fail |
| Parity | `node test/parity-matrix.mjs --check` | fully covered, exit 0 |

## Scope

**In scope**:
- `lib/anti-tell.js` (NEU: `sanitizeTells(text)` — detectTells bleibt
  unverändert; Sanitizer neben detectTells)
- `lib/naturalize.js` (flush: sanitize auf finalDraft + pro Bubble)
- `test/anti-tell.test.js`, `test/naturalize.test.js` (Cases)
- `test/parity-matrix.mjs` (eine Row)

**Out of scope**:
- ANTI_TELL_BLOCK / Split-Prompt (Prompt-Ebene bleibt — der Backstop ist
  Zusatz)
- stripMetaCommentary / detectTells-Bestehendes
- Banned-Lexicon-Erweiterungen (Owner-Entscheidung)

## Git workflow

- Branch: `advisor/027-detect-tells-runtime`
- 1–2 Commits; Stil `plan 027: …`

## Steps

### Step 1: sanitizeTells

In `lib/anti-tell.js` (fail-open, mechanisch, dokumentiert):

```js
export function sanitizeTells(text) {
  if (typeof text !== "string" || !text) return { text, tells: [] };
  const tells = detectTells(text);
  let out = text;
  if (tells.includes("em-dash")) out = out.replace(/\u2014/g, ", ");
  if (tells.includes("bold-markdown")) out = out.replace(/\*\*/g, "");
  if (tells.includes("header")) out = out.replace(/^#+\s*/gm, "");
  if (tells.includes("certainly-exclamation")) out = out.replace(/^Certainly!\s*/gim, "");
  if (tells.includes("customer-service")) out = out.replace(/How can I help you\?/gi, "");
  // listen/list-Marker: Bindestrich-Präfixe strippen (Liste → Fließtext-Zeilen)
  if (tells.includes("list")) out = out.replace(/^\s*[-*+]\s+/gm, "").replace(/^\s*\d+[.)]\s+/gm, "");
  out = out.replace(/[ \t]{2,}/g, " ").trim();
  // bewusst NICHT: banned-words, its-not-its, summary-closing, enumeration —
  // semantische Tells zerstören beim String-Ersatz den Sinn → nur zählen.
  return { text: out, tells };
}
```

Zähl-Doku: semantische Tells (banned-word etc.) werden erkannt + geloggt,
aber NICHT ersetzt (String-Chirurgie an Bedeutung = schlimmer als das
Tell). Bei NUR semantischen Tells: Text unverändert, Warn-Log.

### Step 2: naturalize flush anbinden

1. Auf `finalDraft` (nach stripMetaCommentary/Regenerate, VOR engine.respond):
   ```js
   const san = sanitizeTells(finalDraft);
   if (san.tells.length > 0) _log.warn(`human-engine: tells-sanitized sk=${redactSessionKey(sk)} kinds=${san.tells.join(",")}`);
   finalDraft = san.text;
   ```
   (Roh-Pfad deliverRaw profitiert automatisch.)
2. Pro Bubble nach respondResult (die Bubbles entstehen aus dem Draft,
   aber das Split-LLM kann NEUE Tells produzieren — deshalb):
   ```js
   for (const bubble of scheduled) {
     const b = sanitizeTells(bubble.content);
     if (b.tells.length > 0) _log.warn(`human-engine: tells-sanitized bubble kinds=${b.tells.join(",")}`);
     bubble.content = b.text;
   }
   ```
   Leerer Bubble nach Sanitize (z.B. „Certainly!" allein) → Bubble droppen
   (filter), Rest liefert; wenn ALLE leer → deliverRaw mit finalDraft
   (failsafe).

**Verify**: `node --test test/naturalize.test.js` → pass (Cases Step 3).

### Step 3: Tests + Parity

1. sanitizeTells: Em-Dash→Komma; `**fett**`→fett; Liste→Zeilen;
   Header→stripped; semantische Tells: erkannt, NICHT ersetzt.
2. flush: Fake-engine respond returned Bubble mit Em-Dash → zugestellter
   Payload ohne \u2014 (Dispatcher-Fake-Recorder); Warn-Log-Fake erhielt
   tells-sanitized.
3. „Certainly!"-Only-Bubble → gedroppt; andere Bubble liefert.
4. Bestehende anti-tell/naturalize-Tests grün.
5. Parity-Row: „mechanical tells (em-dash/markdown/lists/headers) are
  sanitized at flush + per-bubble with fail-open semantics; semantic
  tells are logged only".

**Verify**: `npm test` → all pass; Parity fully covered.

## Test plan

Siehe Step 3. Muster: anti-tell.test.js (detectTells-Fälle) +
naturalize-Dispatcher-Fakes.

## Done criteria

- [ ] `rg -n "sanitizeTells" lib/anti-tell.js lib/naturalize.js` → Def + 2 Uses
- [ ] `npm test` exit 0; Parity fully covered
- [ ] `git status` nur In-Scope-Dateien
- [ ] `plans/README.md` Status-Row aktualisiert

## STOP conditions

- Ein Bestands-Test verankert einen Tell-Text als erwarteten Output
  (z.B. ein Bubble-Test mit „—") → das wäre ein veralteter Anker; Report,
  dann Expectation anpassen NACH Rücksprache-Kurve (im Report begründen).
- Sanitizer verändert deutschen Satzsinhn merklich in einem Case →
  Report mit Vorher/Nachher.

## Maintenance notes

- `tells-sanitized`-Warns im Log sind das Regression-Frühwarnsystem:
  Wiederholte Treffer = Split-Modell regrediert (gleiche Beobachtungs-Note
  wie `meta-commentary stripped` im Wiki).
- Semantische Tells bleiben Prompt-Sache — wenn der Owner sie härter will,
  wäre Regeneration (statt Log) der nächste Schritt; bewusst hier NICHT
  gebaut (Kosten/Verzögerung).
