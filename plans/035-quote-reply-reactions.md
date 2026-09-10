# Plan 035: Quote-Reply-Zustellung via replyToId + Reaktions-Fähigkeitskontext (model-routed)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. SKIP the plans/README.md update (reviewer
> maintains the index).
>
> **Drift check (run first)**: compare the "Current state" excerpts against
> LIVE code; apply intent, STOP only on semantic contradiction.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (Message-id-Verfügbarkeit im inbound ctx ist die zentrale Annahme — Step 1 ist ein harter STOP-Gate; Reaktions-Hinweis ist bewusst minimal)
- **Depends on**: none (basis: Wave-2-Endstand)
- **Category**: direction
- **Planned at**: 2026-09-10

## Why this matters

Der Spike (plans/032-native-reactions-spike-report.md) fand die
Host-Fakten: (1) **Quote-Reply ist fast trivial** — `replyToId` ist ein
valides `ReplyPayload`-Feld, WhatsApp mappt es auf `quotedMessageKey`
(`@openclaw/whatsapp` `channel-BeBrHPVa.js:150-178`); dem Plugin fehlt nur
die Ziel-Message-ID im Datenfluss (replyContextQueue/replyTarget tragen
Name/Body, nicht die ID). (2) **Reaktionen sind NICHT plugin-sendbar** —
sie sind eine host message-action (`action:"react"`), der Runner ist kein
Plugin-SDK-Export; der robuste Weg ist model-routed (das Modell nutzt sein
eigenes `message`-Tool). Dieser Plan liefert das plugin-seitig Machbare:
echte Quote-Reply-Zustellung + ein sparsamer Reaktions-Fähigkeits-Hinweis
(im Kontext), OHNE plugin-seitiges Reaktions-Senden und OHNE
Text-Fallback-Risiko.

## Current state

- `lib/gate.js` `onMessageReceived` (~Z. 219-230): Reply-Context
  (`ctx.replyToSender`/`ctx.replyToBody`) → `state.replyContextQueue`
  (qkey = sk|senderId, max 5). Keine Message-ID.
- `lib/gate.js` `onBeforeAgentReply` (~Z. 282-304): Reply-Target-Resolution →
  `state.replyTargetBySession.set(sk, { quotedName, replyToAgent, textHead, ts })`.
- `lib/naturalize.js` flush (~Z. 345-360): `replyTarget` (fresch ≤300 s) →
  `triggerInfo.replyTarget` + `engine.respond({replyTarget})` — der
  Reply-Payload bekommt KEIN `replyToId`.
- `lib/naturalize.js` `deliverWithRetry` (~Z. 69-86, exportiert seit 018):
  Payload `{text}` → bei Host-Reject Retry `{text: content}` (text-only).
- `lib/local-prompts.js` `buildSplitPrompt`: Reply-Target-Zeile existiert
  („you are answering X's message…").
- Host-Fakten (Report 032 §1.3): `ReplyPayload.replyToId?: string` — quote
  target message id; `replyToCurrent?: boolean` existiert ebenfalls (auf
  die eigene letzte Nachricht quoten) — als Fallback-Pfad NOTIEREN, nicht
  bauen.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Unit | `node --test test/gate.test.js test/naturalize.test.js test/local-prompts.test.js` | all pass |
| Tests | `npm test` | all pass, 0 fail |
| Parity | `node test/parity-matrix.mjs --check` | fully covered, exit 0 |

## Scope

**In scope**:
- `lib/gate.js` (message-ID-Capture in replyContextQueue + replyTarget)
- `lib/naturalize.js` (replyToId am ersten Bubble-Payload; Retry behält es)
- `lib/local-engine.js` (respond: replyToId durchreichen)
- `lib/config.js` + `openclaw.plugin.json` (`reactions.hintEnabled: false` NESTED_KEY)
- `lib/local-prompts.js` (KEINE Änderung am Split-Contract — nur falls die
  Reaktions-Hinweiszeile dort renderbar sein muss; sonst gate-only)
- Tests + `test/parity-matrix.mjs` (eine Row)

**Out of scope**:
- Plugin-seitiges Reaktions-Senden (kein SDK-Surface — Report 032 §1.6;
  Revisit, wenn der Host den message-action-runner als SDK-Export freigibt)
- Split-Contract `{kind:"reaction"}` (bewusst NICHT — Reaktionen laufen nie
  durch deliverWithRetry; Report §1.4 TTS-Interplay)
- Sticker/Media-Send

## Git workflow

- Branch: `advisor/035-quote-reply-reactions`; Commits `plan 035: …`

## Steps

### Step 1: Message-ID-Capture (HARTER STOP-GATE)

Prüfe im LIVE-Code + SDK-Typen (`/home/openclaw/.npm-global/lib/node_modules/openclaw/dist/hook-runner-global-*.d.ts`,
`PluginHookMessageReceivedEvent`), welches Feld die INBOUND Message-ID trägt
(Kandidaten: `event.id`, `event.messageId`, `event.metadata?.messageId`,
`event.message?.id`). 

- Feld vorhanden → `replyContextQueue`-Einträge um `msgId` erweitern;
  `replyTargetBySession`-Eintrag um `replyToId` (die ID der ZITIERTEN
  Nachricht — bei Quote-Replies ist das `ctx.replyToId`-Äquivalent falls
  existiert, sonst die Inbound-ID des aktuellen Messages-Kontexts; präzise
  im Code dokumentieren, welche ID WANN die richtige ist: Quoten ZIEL =
  Nachricht, auf die geantwortet wird).
- Feld NICHT vorhanden → STOP (Report: kein ID-Feld auf text-Inbounds —
  dann fällt Quote-Delivery weg und der Plan schrumpft auf Step 3).

**Verify**: Notiz im Commit-Body mit dem verifizierten Feldnamen + file:line.

### Step 2: replyToId bis zum Payload

1. `replyTargetBySession`-Eintrag um `replyToId: string|null` erweitern
   (nur wenn replyToAgent ODER quotedName — wie heute).
2. `lib/naturalize.js` flush: wenn `replyTarget.replyToId` nicht-leer →
   ERSTER scheduled Bubble bekommt `replyToId` mitgegeben; `deliverWithRetry`
   erhält es als Teil des Payloads (`{text, replyToId}`), der Text-only-
   Retry BEHALTET `replyToId` (nicht das Media-Feld — Host-Reject betrifft
   media, nicht quote). Bubbles 2..N ohne replyToId (Quote hängt an der
   ersten).
3. `engine.respond`: `replyTarget` fließt bereits — payload-Bau passiert in
   naturalize (respond liefert content); nichts in local-engine ändern außer
   falls der Timer-Loop die Payloads baut — dort replyToId am ersten Bubble
   injizieren. TTS: `applyTtsToDraft` ist shape-agnostisch (Report 032
   §1.4) — replyToId überlebt.

**Verify**: `node --test test/naturalize.test.js` → pass (Cases Step 4).

### Step 3: Reaktions-Fähigkeitskontext (config-off)

1. Config: `reactions: { hintEnabled: false }` (NESTED_KEYS + Schema + Config-Test).
2. `lib/gate.js` `onBeforePromptBuild`: wenn `reactions.hintEnabled === true`
   UND Gruppen-Session → `appendSystemContext` += EINE Zeile:
   `"You may react to a member's message with the message tool's react action (an emoji reaction is not a reply) — only for clearly reaction-worthy moments, sparingly, never to your own messages. If the channel has reactions disabled, the action fails silently — skip it then."`
   (Instruktion an das Modell, kein untrusted Content — kein wrap nötig;
   bounded, eine Zeile.)
3. Bewusst KEIN Budget plugin-seitig (das Modell-Tool ist host-gated via
   `channels.whatsapp.reactionLevel`; Silent-Fail-Dokumentation steht in der
   Zeile selbst).

**Verify**: `node --test test/gate.test.js` → pass.

### Step 4: Tests + Parity

1. gate: message_received mit ID-Feld → replyContextQueue-Eintrag trägt
   msgId; replyTarget.replyToId gesetzt bei Quote-Reply-Kontext.
2. naturalize: Flush mit replyTarget.replyToId → erster Bubble-Payload
   enthält replyToId, zweite nicht; Host-Reject → Retry-Payload behält
   replyToId.
3. reactions.hintEnabled: false → keine Zeile (Off-Vertrag); true + Gruppe →
   appendSystemContext enthält den Hinweis; DM → nie.
4. Parity-Row am Ende: „quote replies deliver with replyToId on the first
  bubble (host maps it to WhatsApp quotedMessageKey); reaction capability
  hint is opt-in, model-routed, never plugin-sent".

**Verify**: `npm test` → all pass; Parity fully covered.

## Test plan

Siehe Step 4. Anker: bestehende naturalize/deliverWithRetry-Tests (Plan 018)
und FIFO/epoch-Verträge (Plan 545) bleiben unverändert grün.

## Done criteria

- [ ] `rg -n "replyToId" lib/gate.js lib/naturalize.js` → Datenfluss lückenlos
- [ ] `rg -n "hintEnabled" lib/config.js lib/gate.js openclaw.plugin.json` → Treffer
- [ ] `npm test` exit 0; Parity fully covered
- [ ] plans/README.md (vom Reviewer)

## STOP conditions

- Step 1: kein ID-Feld auf Text-Inbounds → STOP mit Befund (Plan schrumpft
  auf Step 3; Reviewer entscheidet).
- Ein TTS/Bubble-Test bricht, weil replyToId den Payload-Bau stört →
  Expectation anpassen ist ok; inhaltlicher Delivery-Bruch (BUBBLE LOST-
  Semantik) → STOP.
- Der Reaktions-Hinweis flippt ein decide-eval-Szenario → STOP mit
  Szenario-Namen.

## Maintenance notes

- Operator-Live-Check nach Deploy (aus Report 032 §3): WhatsApp-Account auf
  `channels.whatsapp.reactionLevel: "minimal"` prüfen/setzen, sonst Silent-
  Fail; Test-Reaktion in einer Gruppe beobachten.
- Wenn der Host den message-action-runner als Plugin-SDK-Export freigibt →
  plugin-seitiges Reaktions-Senden + eigenes Budget wird möglich (dann
  eigener Plan; Report 032 §1.6 Option 1).
