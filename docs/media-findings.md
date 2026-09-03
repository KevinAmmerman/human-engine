# Media signal spike — findings (Plan 510)

Status: **Media fields EXIST on inbound hook events.** Implementation proceeds.

## Where the types live

The plugin's own `node_modules/openclaw/` is only a stub (`plugin-entry.js`
exports `definePluginEntry` only; no `.d.ts` files). The real host SDK types
reside in the global OpenClaw install:

```
/home/openclaw/.npm-global/lib/node_modules/openclaw/dist/
```

Relevant files:
- `hook-types-BSxU_61y.d.ts` — hook event/context shapes.
- `media-facts-DiJU7b10.d.ts` — `MediaFact` runtime fact shape.
- `constants-BCpSHoXd.d.ts` — `MediaKind` union.
- `channel-inbound-GFZVC0qz.d.ts` — inbound media normalization + placeholder
  rendering (`formatMediaPlaceholderText`).
- `run-channel-turn-EkyzILku.js` — JS implementation of placeholder text.

## Inbound hook event media fields (exact names)

On `PluginHookMessageReceivedEvent` and `PluginHookInboundClaimEvent`
(`hook-types-BSxU_61y.d.ts`):

```ts
media?: PluginHookMediaFact[];          // staged, locally usable attachments, stable source order
originalMedia?: PluginHookMediaFact[];  // pre-staging attachment facts
mediaStagingPending?: boolean;          // true when originalMedia present but media withheld
metadata?: PluginHookInboundMessageMetadata;  // deprecated singular aliases mediaPath/mediaType/...
```

`PluginHookMediaFact` (`hook-types-BSxU_61y.d.ts`):

```ts
type PluginHookMediaFact = {
  path?: string;
  url?: string;
  contentType?: string;
  kind?: MediaFact["kind"];
  transcribed?: boolean;
  messageId?: string;
  workspaceDir?: string;
};
```

`MediaKind` (`constants-BCpSHoXd.d.ts:7`):

```ts
type MediaKind = "image" | "audio" | "video" | "document" | "sticker" | "unknown";
```

Note the richer `MediaFact` (`media-facts-DiJU7b10.d.ts`) also carries
`fileName`, `sizeBytes`, `durationMs`, `width`, `height` — a subset of which
is projected onto the hook-facing `PluginHookMediaFact`.

## `before_agent_reply` does NOT carry media

`PluginHookBeforeAgentReplyEvent` (`hook-types-BSxU_61y.d.ts`) is only:

```ts
type PluginHookBeforeAgentReplyEvent = { cleanedBody: string };
```

So the plugin must cache media on `message_received` and read it back in
`onBeforeAgentReply`, exactly as Plan 510 Step 2 prescribes.

## Caption / transcript placement

- Captions arrive inside `cleanedBody` (the inbound message body). The host
  appends an "unavailable media" notice to real caption text via
  `formatInboundMediaUnavailableText` (`run-channel-turn-EkyzILku.js:40`):
  `body + "\n\n" + notice`, or the notice alone when there is no caption.
- For text-only channel surfaces the host renders structured media facts into
  a placeholder string via `formatMediaPlaceholderText`
  (`run-channel-turn-EkyzILku.js:31`), which emits `<media:image>` /
  `<media:video>` / `<media:audio>` / `<media:document>` / `<media:sticker>`
  tags (plus a plural form like `<media:image> (3 images)`).
- Voice notes: a media fact may carry `transcribed?: boolean`; when a
  transcript is delivered the host already folds it into the body that flows
  through `cleanedBody` — no separate marker is needed on our side.

## Consequence for the decide path

- We detect media from `event.media` (or `event.originalMedia`) on
  `message_received`, not by sniffing `cleanedBody` strings. This is a
  verified host capability — **not** heuristic parsing.
- In `onBeforeAgentReply` we look up the cached media for the session key and
  pass a boolean `hasMedia` (and an optional `mediaKind`) into
  `engine.decide`.
- The existing `toServiceMessages` media placeholders (`lib/messages.js`) use
  the token set `[image]`, `[video]`, `[voice message]`, `[audio]`,
  `[document]`, `[sticker]` — note these differ from the plan's illustrative
  `[photo]`/`[voice]` tokens; the actual code values are used.
