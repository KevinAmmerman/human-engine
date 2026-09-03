# Conversational Time — Nachrichtenalter im Decide/Split-Kontext

## Problem

Der Agent kann nicht unterscheiden, ob die neueste Nachricht 5 Sekunden oder
3 Tage alt ist: Timestamps werden vor jedem Prompt entfernt. Ein Mensch
antwortet auf eine frische Frage schnell und auf eine Stunden alte Nachricht
mit „sorry, grad erst gesehen". Das ist der größte strukturelle „fühlt sich
wie ein Bot"-Gap nach Medien (Plan 510).

## Ts-Quelle (gewählt)

`message_received` trägt optional `timestamp?: number` (Host-Ts, belegt in
`PluginHookMessageReceivedEvent`, openclaw SDK types.d.ts:2187). Wenn vorhanden
wird er genutzt; sonst `Date.now()` beim Empfang als Fallback. Bewahrt man auf
dem observed-store-Pfad (gate `persist()`) — gleiche Quelle.

## Threading durch die Ebenen

- `state.js`: `peekMetaBySession` Map (sk → Array von `{ts}`), index-aligned
  mit den Peek-Lines, beide identisch gedeckelt. `pushTranscriptPeek` nimmt
  optionales 4. Argument `ts`; `getTranscriptPeek` liefert `{speaker, text, ts?}`
  durch Index-Abgleich.
- `gate.js`: beide Push-Sites (`onMessageReceived`, `pushPeekDedup`) reichen den
  Ts durch; `mergeTranscriptLayers` erhält `ts` (`{speaker, text, ts}`).
- observed-Layer hat den Ts bereits.

## Annotationsformat

`[${speaker}]${age} ${text}` — age direkt nach dem Speaker, nur wenn nicht leer.

- `formatAge(ts, nowMs)`:
  - null/0 → `""` (alte Lines unannotiert)
  - < 30 min → `""` (frische Lines nie annotiert)
  - < 24 h → `"(vor Xh)"` (Stunden, aufgerundet)
  - sonst → `"(vor Xd)"` (Tage, aufgerundet)

Deutsch, passend zur Gruppensprache. Die aktuelle (neueste) Message wird nie
annotiert — sie ist per Definition frisch.

## Decide-Regel (System-Prompt)

> Message ages are shown like (vor 3h). If the newest message is hours or days
> old, you may acknowledge the late reply naturally — briefly, and never
> over-apologize; when in doubt, skip the acknowledgment.

## Over-Apology-Guard

Die Annotation ist reine DATA, keine Instruktion zum Entschuldigen. Die Regel
begrenzt explizit: „briefly, and never over-apologize; when in doubt, skip".
Review: kein Prompt-Anteil darf als Befehl zum permanenten Entschuldigen gelesen werden.

## Out of Scope

- Timing-Engine (Plan 515).
- Backfill alter Lines (ts:0 → unannotiert).
- Proactive-Trigger-Zeit-Mathematik.

## Naturliche Kombination mit Plan 511

Reply-Target + Alter: „Basti's message from vor 2 Tagen" — wird revisitiert, wenn beide Pläne gelandet sind.