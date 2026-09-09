# Plan 032: Native-Reaktionen Spike — Reaktionen/Quotes/Emoji-Replies als Ausgabe-Typen (Fähigkeits-Klärung)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`. Deliverable: `plans/032-native-reactions-spike-report.md`. KEIN Build.
>
> **Drift check (run first)**: `git -C ~/human-engine diff --stat c4e148b..HEAD -- lib/naturalize.js`
> On mismatch: STOP condition.

## Status

- **Priority**: P3
- **Effort**: M (Recherche + Fähigkeits-Matrix + kleinster Vorschlag)
- **Risk**: LOW (read-only; keine Produktionsänderung)
- **Depends on**: none
- **Category**: direction (spike)
- **Planned at**: commit `c4e148b`, 2026-09-09

## Why this matters

Echte WhatsApp-Gruppen kommunizieren massenhaft in nativen Formen:
Emoji-Reaktionen auf Nachrichten, Quote-Replies, Sticker. Der Agent kann
nur Text-Bubbles (`{"messages": ["…"]}` → `sendBlockReply({text})`).
Text-lastige Teilnahme ist in einem Emoji/Quote-getriebenen Raum der
verbleibende Roboter-Tell auf Ausgabe-Seite. Bevor ein Feature-Plan
entsteht: Klären, was der Host/Dispatcher überhaupt kann
(`sendBlockReply`-Payload-Contract, SDK), was der WhatsApp-Channel
zulässt (Reaktions-API) und was der TTS-Pfad (Plan 548b — Payload
gewinnt mediaUrl) daran mitbestimmt.

## Current state

`lib/local-prompts.js:233-234` (Split-Contract):

```js
`Split the reply into 1\u2013${maxBubbles || 5} chat messages the way a person fragments a thought. …`,
'Return STRICT JSON: {"messages": ["...", ...]}, nothing else.',
```

`lib/naturalize.js:69-103` — deliverWithRetry →
`dispatcher.sendBlockReply(payload)` (payload heute: `{text}` bzw. nach
applyTtsToDraft `{text, mediaUrl, audioAsVoice}`); buildTtsContext zeigt
die vom Host akzeptierten Payload-Felder (text/mediaUrl/mediaUrls).
Der Dispatcher kommt aus dem Hook-ctx (`reply_dispatch`, ctx.dispatcher).
SDK-Typen (node_modules/openclaw-Plugin-SDK, types.d.ts) definieren den
Payload-Typ — zu verifizieren, ob reaction/quote/sticker-Felder oder
eigene Dispatcher-Methoden existieren.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Tests | `npm test` | all pass, 0 fail |

## Scope

**In scope**:
- SDK-/Host-Recherche: dispatcher-Typ (sendBlockReply-Signatur + Payload-
  Typ), message-action-Runner (Reaktions-Fähigkeit des Hosts?),
  WhatsApp-Channel-Reaktions-Support (OpenClaw-Channels-Doku/Code)
- Live-Bestand: keine Änderung
- `plans/032-native-reactions-spike-report.md` (NEU — Deliverable)

**Out of scope**:
- Jeder Build/Commit auf lib/
- Split-Prompt-Änderungen

## Git workflow

- Kein Branch nötig (read-only + Report). Falls Notizen: Branch `spike/032-native-reactions`, kein Merge.

## Steps

### Step 1: Dispatcher-Contract inventarisieren

1. SDK-Typen des Dispatchers (types.d.ts, `reply_dispatch`-ctx-Typ):
   Welche Payload-Felder? `reaction`? `quotedMessageId`? Methoden
   neben sendBlockReply/markComplete?
2. TTS-Interaktion: applyTtsToPayload (tts-runtime) — akzeptiert es nur
   text/media oder beliebige Payloads?
3. WhatsApp-Channel-Seite (OpenClaw host/whatsapp-Channel-Doku im
   Gateway-Setup — NICHT im Plugin-Repo): Reaktions-/Quote-Send-API
   vorhanden? (Agent-vault/Host-Notizen im Workspace-Wiki als Quelle
   erlaubt, aber Plugin-Repo ist die Baustelle.)

**Verify**: Report-Abschnitt 1 mit Typ-Zitaten (file:line aus SDK/types
bzw. Host-Doku-Links).

### Step 2: Fähigkeits-Matrix + kleinster Vorschlag

Report-Abschnitt 2:

| Form | SDK fähig? | Channel fähig? | Aufwand bei ja |
|------|-----------|----------------|-----------------|
| Emoji-Reaktion auf Nachricht | ? | ? | Split-Contract erweitert `{kind:"reaction", emoji:"…"}` + deliverWithRetry-Zweig |
| Quote-Reply (auf Mitgliedernachricht) | ? | ? | replyTarget + quotedMessageId-Datenfluss (replyContextQueue) |
| Sticker/Media-Send | ? | ? | Payload mediaUrl (TTS-Pfad zeigt Form) |

Dazu: kleinster sinnvoller FIRST-Schritt-Vorschlag (Vermutung:
Emoji-Reaktion auf Quote-Replies auf die eigene Nachricht — wir haben
die reply-Daten schon, Reaktion ist kleiner als Quote-Send), Risiken
(Silent-Fail im Kanal, Budget: Reaktion zählt als speak?), und der
Entwurf des Follow-up-Plans (Nummer reservieren).

**Verify**: Report existiert mit Matrix + Vorschlag + Follow-up-Nummer.

## Test plan

Keiner (Spike). `npm test` unverändert grün.

## Done criteria

- [ ] `plans/032-native-reactions-spike-report.md` existiert (Abschnitte
      1 + 2, file:line-Belege)
- [ ] `git status` — kein Diff auf lib/
- [ ] `plans/README.md` Status-Row aktualisiert

## STOP conditions

- SDK/Channel-Quellen im Worktree nicht auffindbar (shim ohne Typen) →
  Report-Gap dokumentieren + Host-Doku-Verifizierung als
  Operator-Schritt vorschlagen.
- Die Fähigkeitsfrage ist bereits anderweitig beantwortet (z.B. ein
  Host-Release hat Reaktionen dokumentiert) → Report kurz halten und
  direkt zum Follow-up-Plan-Entwurf springen.

## Maintenance notes

- Wenn Reaktionen machbar sind: der Follow-up-Plan MUSS das
  Anti-Annoyance-Thema addressieren (Reaktions-Spam ist der schnellste
  Weg, „human" zu „gruselig" zu machen) — Budget-Analog zum
  proactive-Funnel.
- TTS-Interplay (Plan 548b): jede neue Payload-Form muss den
  deliverWithRetry-Retry (text-only-Fallback) mitdenken.
