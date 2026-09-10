# Plan 032 — Native-Reaktionen Spike Report

> Status: **DONE** (Research spike — no production code changed).
> Deliverable of plan `plans/032-native-reactions-spike.md`.
> Follow-up slot reserved: **035** (033 = self-voice, 034 = media caption, both taken).

## 0. Drift / scope check

- Drift check command `git -C ~/human-engine diff --stat c4e148b..HEAD -- lib/naturalize.js`
  reports `lib/naturalize.js` changed (24 insertions / 8 deletions) relative to `c4e148b`,
  but that diff is **entirely** carried by the already-landed, advisor-reviewed commits on
  this worktree (plans 025 and 031, which themselves touched `lib/naturalize.js` for media
  caption + self-voice delivery). The plan's quoted excerpt — `deliverWithRetry` at
  `lib/naturalize.js:69-103` and the split-contract at `lib/local-prompts.js:362-363` —
  matches the current files **exactly** (verified below). The main checkout state is out
  of scope for this spike (per executor context). No STOP condition triggered.
- Worktree clean under `lib/` and `test/`: `git status --short -- lib test` → empty
  (only untracked `node_modules` at repo root, which is the symlinked SDK shim).
- `npm test` → **1096 pass, 0 fail** (node --test summary: `ℹ tests 1096 / ℹ pass 1096 /
  ℹ fail 0 / ℹ cancelled 0 / ℹ skipped 0`), parity matrix `77/77 covered
  (77 tested, 0 skipped)`, exit 0. No production drift.

---

## 1. SDK-Inventur (read-only)

### 1.1 Where the types live

The plugin-local `node_modules/openclaw/` (in the worktree) is a **stub**:
`plugin-entry.js` exports only `definePluginEntry`; its `package.json` exposes a single
surface `./plugin-sdk/plugin-entry`. There are **no `.d.ts` files** and **no
`tts-runtime` / `reply-dispatch`** exports in the shim. The authoritative host SDK lives
at:

```
/home/openclaw/.npm-global/lib/node_modules/openclaw/dist/
```

(reused from plan 025's approach). The `reply_dispatch` hook contract is in
`hook-runner-global-DZetem8r.d.ts`; the base payload type is in
`reply-payload-CATHoq29.d.ts` and its re-exports.

### 1.2 `reply_dispatch` dispatcher type (`ReplyDispatcher`)

`ReplyDispatcher` is defined at `agent-harness-runtime-DaJ4mxKg.d.ts:536-554` (and
`hook-runner-global-DZetem8r.d.ts:889`, `cli-backend.types-BIb149tl.d.ts:2598-2610`):

```ts
type ReplyDispatcher = {
  prepareReplyPayload?: (kind: ReplyDispatchKind, payload: ReplyPayload) => NormalizeReplyOutcome<ReplyPayload>;
  sendToolResult: (payload: ReplyPayload) => boolean;
  sendBlockReply: (payload: ReplyPayload) => boolean;
  sendFinalReply: (payload: ReplyPayload) => boolean;
  appendBeforeDeliver?: (hook: ReplyDispatchBeforeDeliver, options?: ReplyDispatchBeforeDeliverOptions) => void;
  supportsSettledReceipt?: true;
  waitForIdle: () => Promise<void | ReplyDispatchReceipt>;
  getQueuedCounts: () => Record<ReplyDispatchKind, number>;
  getCancelledCounts?: () => Record<ReplyDispatchKind, number>;
  getFailedCounts: () => Record<ReplyDispatchKind, number>;
  markComplete: () => void;
  resolveFollowupAdmissionBarrierTimeoutPolicy?: () => ReplyFollowupAdmissionBarrierTimeoutPolicy | undefined;
};
```

Confirmed in the runtime construction at `reply-dispatcher-UJoV3oQM.mjs:473-505`
(`sendToolResult`/`sendBlockReply`/`sendFinalReply` all funnel into an internal
`enqueue(kind, payload)`; `markComplete` decrements the pending counter).

**Key findings on the dispatcher contract:**

- **`sendBlockReply` signature**: `(payload: ReplyPayload) => boolean` — it only *queues*
  a reply for delivery. It has **no reaction/quote-specific method**.
- **Methods besides `sendBlockReply`/`markComplete`**: `sendToolResult`,
  `sendFinalReply`, `prepareReplyPayload`, `appendBeforeDeliver`, `waitForIdle`,
  `getQueuedCounts`, `getCancelledCounts`, `getFailedCounts`,
  `resolveFollowupAdmissionBarrierTimeoutPolicy`. There is **no `sendReaction` /
  `react` method** on the dispatcher.
- **The dispatcher is the WRONG surface for reactions.** Reactions in the host are a
  *message-action* (`action:"react"`), not a reply-payload delivery.

### 1.3 `ReplyPayload` type — no top-level `reaction`/`quotedMessageId` field

The base type `ReplyPayload` (`reply-payload-CATHoq29.d.ts:63-132`, re-exported in
`plugin-entry-gCZx1lOy.d.ts:9668-9730`, `health-tuyyTTVY.d.ts:13054-13123`,
`cli-backend.types-BIb149tl.d.ts`):

```ts
type ReplyPayload = {
  text?: string;
  fallbackText?: { text: string; replacesPayloadIndex?: number };
  mediaUrl?: string;
  mediaUrls?: string[];
  attachments?: ReplyMediaAttachment[];
  trustedLocalMedia?: boolean;
  sensitiveMedia?: boolean;
  presentation?: MessagePresentation;
  presentationTextMode?: "fallback";
  delivery?: ReplyPayloadDelivery;
  interactive?: InteractiveReply;          // @deprecated → use presentation
  btw?: { question: string };
  replyToId?: string;                       // quote target message id
  replyToTag?: boolean;
  replyToCurrent?: boolean;
  audioAsVoice?: boolean;
  videoAsNote?: boolean;
  location?: OutboundLocation;
  spokenText?: string;
  ttsSupplement?: ReplyPayloadTtsSupplement;
  isError?: boolean;
  isReasoning?: boolean;
  isCommentary?: boolean;
  isReasoningSnapshot?: boolean;
  isCompactionNotice?: boolean;
  isFallbackNotice?: boolean;
  isStatusNotice?: boolean;
  channelData?: Record<string, unknown>;
};
```

**Verdict**: there is **no `reaction` and no `quotedMessageId` field** on `ReplyPayload`.
Quote-reply is expressed via **`replyToId`** (a message id), and **reactions are NOT a
payload concern at all** — they are a separate message-action (`action:"react"`). The
plugin's `deliverWithRetry` currently passes `{text}` / `{text, mediaUrl, audioAsVoice}`
and could also pass `replyToId`, but it cannot express a native reaction via
`sendBlockReply`.

### 1.4 TTS interplay (`maybeApplyTtsToPayload`)

The TTS applier used by the plugin is `maybeApplyTtsToPayload` (host implementation
`runtime-api-3eLQyNrh.mjs`, core `maybeApplyTtsToPayloadCore` at line 873). The plugin
calls it via `loadTtsApplier` (`lib/naturalize.js:28-38`) importing
`openclaw/plugin-sdk/tts-runtime`, and wraps it in `applyTtsToDraft`
(`lib/naturalize.js:47-67`).

**What shapes pass through:**

- `maybeApplyTtsToPayloadCore` (`runtime-api-3eLQyNrh.mjs:873-975`) accepts a generic
  `params.payload` and:
  - returns the payload untouched if `ttsAuto === "off"`, if `isCompactionNotice`, if
    auto-mode gating fails (`commandReply`, `tagged`/`inbound` without directive), or if
    `reply.hasMedia`/`hasLegacyFinalMediaDirective(text)` (line 916).
  - Otherwise it synthesizes audio from `reply.text` and returns `{ ...payload,
    mediaUrl, audioAsVoice, spokenText, trustedLocalMedia }`.
- The plugin's `applyTtsToDraft` (`lib/naturalize.js:47-67`) passes the whole
  `payload` object through and keeps whatever shape comes back. **It is shape-agnostic**
  for payloads it hands to `maybeApplyTtsToPayload`, because the host's TTS applier only
  reads `payload.text` + `payload.isCompactionNotice` + media flags — extra fields such as
  a hypothetical `{kind:"reaction", emoji}` are carried through unchanged (they don't
  break TTS, and TTS would just ignore a text-less reaction payload because
  `!ttsText.trim()` / `text.length < 10` short-circuits).

**Implication for reactions**: a reaction-only payload (no text) would either (a) not be
deliverable via `sendBlockReply` (a reaction is not a reply delivery), or (b) if routed as
a reaction message-action, it bypasses `applyTtsToDraft` entirely — no TTS side effects,
which is correct (a reaction should never be "spoken"). The `deliverWithRetry` text-only
fallback (`lib/naturalize.js:77-84`) must NOT be applied to a reaction action; a reaction
that fails should be silently dropped, not retried as a text bubble.

### 1.5 WhatsApp channel-side reaction/quote capability (external plugin)

The WhatsApp runtime is an **external plugin** `@openclaw/whatsapp` (ships outside core
OpenClaw; docs `docs/channels/whatsapp.md:12-15`). It is installed at
`~/.openclaw/npm/projects/openclaw-whatsapp-*/node_modules/@openclaw/whatsapp/`. Evidence:

**Agent-initiated reactions: YES, via `action:"react"` message-action.**

- `dist/action-runtime-CRZLhN3f.js:28-71` handles `action === "react"` for WhatsApp:
  gated on `channels.whatsapp.reactionLevel` (`agentReactionsEnabled`, line 40) and
  `actions.reactions`, then calls `sendReactionWhatsApp(to, messageId, emoji, …)`.
- `dist/send-BDDGPxav.js:652-690` implements `sendReactionWhatsApp` via the active web
  listener (`active.sendReaction(chatJid, messageId, emoji, fromMe, participant)`).
- `dist/send-BDDGPxav.js:30-40` `resolveWhatsAppReactionLevel` — default `"minimal"`.
- The reaction-level semantics come from core `status-helpers-BNiuIkFH.mjs:73-100`:
  `"minimal"`/`"extensive"` → `agentReactionsEnabled: true` with `agentReactionGuidance`;
  `"off"`/`"ack"` → agent reactions disabled. Config: `channels.whatsapp.reactionLevel`
  (`docs/channels/whatsapp.md:460-475`), levels `off|ack|minimal|extensive`.

**Quote-reply: YES, via `replyToId` on the reply payload.**

- `dist/channel-BeBrHPVa.js:150-178` resolves a `quotedMessageKey` from `params.replyToId`
  (looking up inbound message metadata in the account's cache), and passes it to
  `sendMessageWhatsApp` (`dist/send-BDDGPxav.js:578-591` uses `quotedMessageKey` →
  `replyToId`/`replyToIdSource`/`replyToMode`).
- The human-engine plugin already captures `ctx.replyToSender`/`ctx.replyToBody` into
  `replyContextQueue` (`lib/gate.js:219-230`) and resolves a `replyTarget`/`quotedName`
  (`lib/gate.js:282-304`) — but it does **not** currently carry the underlying message
  **id** through to `sendBlockReply`. Quote-send would require plumbing a `replyToId`
  (the target message id) into the payload; the plugin has the *name/body* but not yet the
  *id* at delivery time.

**Core (non-WhatsApp) reaction path** is Telegram-specific: `action-runtime-e23CixH0.mjs`
(reaction via `channelData.reaction.emoji`, `send-DXUqnh0R.mjs:2385-2420`,
`delivery-bFgF6dDN.mjs:479-567`, outbound adapter `outbound-adapter-Dzs2Cdcv.mjs:214-232`).
The general `react` message-action exists across channels (`message-action-names-BPz1joQd.mjs`,
`message-action-normalization-CO55JiFo.mjs`), with a shared `resolveReactionMessageId`
helper (`channel-actions-CneYUR_i.mjs:29`). The core `ReplyPayload` carries reactions only
via `channelData` (Telegram); WhatsApp exposes its own `react` action in the external
plugin.

### 1.6 Plugin-reachability of the react action (how could human-engine send one?)

The `react` message-action is reachable to the **model / CLI / channel plugin** via
`runMessageAction` (`message-action-runner-Bymt2nEX.mjs:1872`), but it is **NOT exposed
as a plugin-SDK import surface** for hook plugins. Grep of `package.json` `exports`
(`./plugin-sdk/*`, 338 surfaces) shows **no `message-action-runner` / `run-message-action`
surface**; `channel-actions` (the closest SDK) exports only *helpers*
(`resolveReactionMessageId`, `readReactionParams`, gates) — **no `sendReaction`/`react`
sender**. So a hook plugin like human-engine **cannot directly invoke** the WhatsApp
`react` action through a typed SDK export today.

**Options for human-engine to emit a reaction** (all require a follow-up design step):
1. Route through the **message-action runner** if the host later exposes it (or via an
   internal hook-injected capability) — not currently a public SDK surface.
2. **Let the model emit it natively** — extend the split contract so the model may return
   `{kind:"reaction", emoji, replyToId}` and have the agent's own main turn call the
   `react` message-tool (the model already has the `message` tool with `action:"react"`).
   This is the most robust path since the model-side tool IS available.
3. `channelData`-based reaction — only Telegram core supports it today; WhatsApp reactions
   are not carried on the reply payload.

---

## 2. Fähigkeits-Matrix + kleinster Vorschlag

| Form | SDK fähig? (dispatcher/payload) | Channel fähig? (WhatsApp) | Aufwand bei ja |
|------|--------------------------------|---------------------------|----------------|
| **Emoji-Reaktion auf Nachricht** | **Nein** als Payload-Feld; **Nein** auf `ReplyDispatcher`; vorhanden nur als `action:"react"` message-action (nicht als SDK-Import für Hook-Plugins) | **Ja** — WhatsApp `react`-Action (`@openclaw/whatsapp` `action-runtime-CRZLhN3f.js:32`), gated auf `reactionLevel` minimal/extensive | **M**: Model-seitig über die `message`-Tool `action:"react"` (Modell-Tool ist verfügbar) ODER Host muss den action-runner als Plugin-SDK-Surface freigeben. Split-Contract erweitert `{kind:"reaction", emoji, replyToId}` + ein Delivery-Zweig außerhalb von `deliverWithRetry`. |
| **Quote-Reply (auf Mitgliedernachricht)** | **Teilweise** — `replyToId` ist ein valides `ReplyPayload`-Feld | **Ja** — `replyToId` → `quotedMessageKey` → `sendMessageWhatsApp` (`channel-BeBrHPVa.js:156-178`) | **S–M**: `replyToId`-Datenfluss durch `deliverWithRetry`/`sendBlockReply`. Plugin hat Name/Body im `replyContextQueue` (`lib/gate.js:219-230`), aber **noch nicht die message-id** zum Zeitpunkt der Zustellung — id muss aus dem inbound `ctx` extrahiert und bis `sendBlockReply({text, replyToId})` mitgeführt werden. |
| **Sticker/Media-Send** | **Ja** — `mediaUrl`/`mediaUrls` im Payload (TTS-Pfad zeigt die Form: `{text, mediaUrl, audioAsVoice}`) | **Ja** — WhatsApp sendet media über denselben Sendepfad (`send-BDDGPxav.js`) | **S**: bereits durch den TTS-Pfad demonstriert; Sticker sind eine eigenständige (nicht untersuchte) message-action. |

### Empfehlung — kleinster sinnvoller FIRST-Schritt

**Emoji-Reaktion auf Quote-Replies auf die eigene Nachricht**, aber **model-routed**:

- Der Plugin erzeugt KEINE Reaktion selbst (kein Plugin-SDK-Surface dafür vorhanden).
  Stattdessen erweitert der Split-Contract die erlaubte Antwortform um einen optionalen
  Reaktions-Eintrag (`{kind:"reaction", emoji, replyToId}`), und die Zustellung erfolgt
  über den **bereits verfügbaren `message`-Tool** des Modells (`action:"react"`), nicht
  über `sendBlockReply`. Das umgeht die fehlende Plugin-SDK-Reachability und nutzt das,
  was der Host wirklich unterstützt.
- Begründung: Reaktion ist kleiner als Quote-Send (nur Emoji + message-id, keine Text-
  Zustellung), und wir haben die Reply-Kontexte bereits (`replyContextQueue`). Aber die
  **Message-id** muss noch vom inbound `ctx` bis zur Reaktions-Entscheidung durchgereicht
  werden — das ist die eigentliche Datenfluss-Arbeit.
- **Achtung Silent-Fail**: `reactionLevel` muss für den WhatsApp-Account auf
  `minimal`/`extensive` stehen, sonst wirft die `react`-Action und es passiert nichts
  sichtbar (kein Text, keine Reaktion). Konfig-Check nötig.
- **Budget**: Eine Reaktion zählt **nicht** als `speak` (kein Text → keine TTS, keine
  Bubble). Aber sie sollte gegen eine kleine Tages-Reaktionsbudget-Grenze laufen
  (Analogie zum `proactive`-Funnel), um Reaktions-Spam zu verhindern.

### Anti-Annoyance / Budget-Design-Notizen (für Reactions)

- **Reaktions-Spam ist der schnellste Weg von „human" zu „gruselig"** (Plan-Vorgabe).
  Budget analog zum proactive-Funnel: z.B. `reactionsPerDay` (default klein, z.B. 2–3),
  `minGapMinutes` zwischen Reaktionen, keine Reaktion auf die eigene letzte Nachricht ohne
  neuen Trigger.
- Reaktionen nur auf **klar reaktionswürdige** Momente (Mitglied feiert einen Erfolg,
  ein Plan/Send/Climb landet), niemals als generisches „👀" auf jede Nachricht.
- `reactionLevel`-Respekt: wenn der Kanal `"ack"`/`"off"` ist, keine agent-initiated
  Reaktion versuchen (Silent-Fail vermeiden).
- **TTS-Interplay**: Reaktionen laufen komplett am TTS-Pfad vorbei. Der `deliverWithRetry`
  text-only-Fallback (`lib/naturalize.js:77-84`) darf NIE auf eine Reaktion angewendet
  werden — eine fehlgeschlagene Reaktion wird still verworfen, nicht als Text-Bubble
  retried. Jeder neue Payload-/Action-Typ muss diesen Retry-Pfad mitdenken (Plan 548b).

### Follow-up plan draft — Plan **035** (nächster freier Slot)

**Plan 035 — Native Emoji-Reaktionen via model-routed `react` message-action (M, build).**

- **Ziel**: Die Gruppe kann den Agenten auf native Emoji-Reaktionen reagieren lassen,
  ohne dass der Agent textlastige Robot-Bubbles für Ein-Emoji-Momente schreibt.
- **Schritte**:
  1. **Message-id-Plumbing**: inbound `ctx` → message-id des Reply-Targets bis zur
     Reaktions-Entscheidung durchreichen (analog zum bestehenden `replyContextQueue`
     Name/Body-Fluss in `lib/gate.js:219-230`). Speichere `replyToId` im
     `replyContextQueue`-Eintrag.
  2. **Split-Contract-Erweiterung** (`lib/local-prompts.js:362-363`): erlaubte Antwort
     `{kind:"reaction", emoji, replyToId}` als optionaler Eintrag, NUR in
     reaktionswürdigen Kontexten (keine Default-Erzeugung).
  3. **Delivery-Zweig**: die Reaktion wird über das `message`-Tool `action:"react"`
     (Modell-Tool) gesendet — NIE über `deliverWithRetry`. Fehlgeschlagene Reaktionen
     still verwerfen (kein Text-Fallback).
  4. **Budget + Anti-Annoyance**: `reactionsPerDay` / `minGapMinutes`-Config, analog zum
     `proactive`-Funnel; keine Reaktion bei `reactionLevel` `"off"`/`"ack"`.
  5. **Verifikation live** (host-side, Operator-Schritt): mit einem Test-Account
     `reactionLevel:"minimal"` setzen und eine echte Gruppe die Reaktion auslösen lassen;
     prüfen dass die `react`-Action eine Message-id erfordert (WhatsApp braucht ein
     konkretes Ziel).
- **Risiken**: (a) `react`-Action ist nicht als Plugin-SDK-Import verfügbar → der
  Model-routed Weg (Modell ruft den eigenen `message`-Tool) ist der robusteste, muss aber
  gegen den tatsächlichen Tool-Call des Haupt-Agents verifiziert werden; (b) Silent-Fail
  bei falscher `reactionLevel`; (c) Reaktion braucht eine gültige Ziel-message-id.

---

## 3. Additional findings

- **Der Dispatcher ist die falsche Fläche für Reaktionen.** `ReplyDispatcher` hat keine
  Reaktions-Methode und `ReplyPayload` kein `reaction`-Feld; Reaktionen sind im Host eine
  eigene `message-action` (`action:"react"`). Das ist der wichtigste strukturelle Befund.
- **Quote-Reply ist fast trivial machbar** — `replyToId` ist ein valides Payload-Feld und
  WhatsApp mappt es auf `quotedMessageKey`. Die einzige fehlende Zutat ist die
  Ziel-message-id im Plugin-Datenfluss (derzeit nur Name/Body im `replyContextQueue`).
- **TTS ist für Reactions irrelevant**: reaction-only Payloads hätten keinen Text, würden
  also vom TTS-Applier ohnehin ignoriert; der `deliverWithRetry`-Text-Fallback muss für
  Reactions ausgeschaltet bleiben.

---

## 4. Verification summary (this session)

- `npm test` → **1096 pass, 0 fail**, `ℹ fail 0`, parity `77/77`, exit 0. ✅
- `git status --short -- lib test` → **empty** (no production drift). ✅
- All file:line claims above were read directly from the host dist / external WhatsApp
  plugin in this session. ✅

### Host-side live verification suggestion (for the follow-up / reviewer)

- With a real WhatsApp test account at `reactionLevel:"minimal"`, confirm the model-routed
  `message`-tool `action:"react"` actually lands a reaction and that a missing
  `messageId` fails loudly (not silently) — the WhatsApp `react` handler requires
  `messageId` (`action-runtime-CRZLhN3f.js:42`).
