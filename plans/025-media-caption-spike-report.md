# Plan 025 — Media-Caption Spike Report

> Status: **DONE** (Research spike — no production code changed).
> Deliverable of plan `plans/025-media-caption-spike.md`.

## 0. Drift / scope check

- Drift check command `git -C ~/human-engine diff --stat c4e148b..HEAD -- lib/gate.js docs/`
  reports lib/gate.js changed since `c4e148b` (75 insertions / 13 deletions), but the
  plan's quoted excerpt — `detectInboundMedia` at `lib/gate.js:26-35` — matches the
  current file **exactly** (verified byte-for-byte in the worktree). The decide-prompt
  media line also matches. No STOP condition triggered.
- Worktree state clean: `git status --short` under `lib/` and `test/` is empty
  (only untracked `node_modules` at repo root, which is the symlinked SDK shim).
- `npm test` → **1084 pass, 0 fail** (node --test summary: `ℹ pass 1084 / ℹ fail 0 /
  cancelled 0 / skipped 0`), parity matrix `77/77 covered (77 tested, 0 skipped)`,
  exit 0. No production drift.

---

## 1. SDK-Inventur (read-only)

### 1.1 Where the types live

The plugin-local `node_modules/openclaw/` (in the worktree, symlinked) is only a
**stub**: `plugin-entry.js` exports `definePluginEntry` only; there are **no `.d.ts`
files** there. The real host SDK types live in the global OpenClaw install:

```
/home/openclaw/.npm-global/lib/node_modules/openclaw/dist/
```

`test/helpers/ensure-plugin-sdk-shim.mjs` only writes the `plugin-entry.js` stub
(verified: it writes `package.json` + `plugin-entry.js`, nothing else). So the
worktree shim does **not** contain the media hook types — this is a documented gap;
the authoritative shape comes from the host install (see file:line evidence below).

### 1.2 `PluginHookMessageReceivedEvent` / media fact shape (host types)

Verified in `hook-runner-global-DZetem8r.d.ts`:

- `PluginHookMessageReceivedEvent` (lines 354–376) has:
  - `media?: PluginHookMediaFact[]`
  - `originalMedia?: PluginHookMediaFact[]`
  - `mediaStagingPending?: boolean`
  - `metadata?: PluginHookInboundMessageMetadata`
  - plus scalar fields (`content`, `from`, `timestamp`, `threadId`, `replyTo*`, `sessionKey`, …).
- `PluginHookMediaFact = MessageHookMediaFact` (line 202), defined at
  `hook-runner-global-DZetem8r.d.ts:190-197`:

  ```ts
  type MessageHookMediaFact = {
    path?: string;
    url?: string;
    contentType?: string;
    kind?: MediaFact["kind"];
    transcribed?: boolean;
    messageId?: string;
    workspaceDir?: string;
  };
  ```

  The same fact shape is confirmed in `agent-harness-runtime-DaJ4mxKg.d.ts:672-680`.

- `MediaKind` union (`constants-BCpSHoXd.d.ts:7`):
  `"image" | "audio" | "video" | "document" | "sticker" | "unknown"`.

**Answer to the plan's question (1) — is there a `caption` / `transcription` field
on the media fact?**

**No.** The hook-facing `MessageHookMediaFact` has **no `caption` field**. It exposes
`path`, `url`, `contentType`, `kind`, `transcribed` (boolean only), `messageId`,
`workspaceDir`. The richer internal `MediaFact`
(`media-facts-DiJU7b10.d.ts`) adds `fileName`, `sizeBytes`, `durationMs`, `width`,
`height` — but **no caption text** either.

**Captions actually arrive inside the message body, not the media fact.** Host
`run-channel-turn-CxpIl7IS.mjs`:
- `formatInboundMediaUnavailableText` (lines 39–44): appends an "unavailable media"
  notice to the real caption, or returns the notice alone when there is no caption.
  So a media message's `event.content` (= `cleanedBody` at `before_agent_reply`)
  contains the **caption text** (or the notice) — the caption is reachable via the
  body, not via a `media[].caption` field.
- For text-only channel surfaces the host renders media facts into a placeholder
  tag via `formatMediaPlaceholderText` (lines 31–37): `<media:image>`,
  `<media:video>`, `<media:audio>`, `<media:document>`, `<media:sticker>` (and a
  plural form like `<media:image> (3 images)`).

So the plan's matrix row "Caption im Event vorhanden" is satisfied — **but through
`event.content`, not through a media-fact caption field.** The code already routes
the body into the decide path (`lib/gate.js:243-268` `onBeforeAgentReply` reads
`event.cleanedBody`).

### 1.3 Does the MAIN agent turn see the media natively (Vision)?

Host types show multimodal/vision support at the agent-run layer:
- `AgentCommandOpts` (`agent-harness-runtime-DaJ4mxKg.d.ts`, ~line 22250+) has
  `images?: ImageContent[]`, `imageOrder?: PromptImageOrderEntry[]`,
  `media?: MediaFact[]`, `transcriptMedia?: UserTurnInput["media"]`.
- `context-media-runtime-GGMM19zz.mjs` (`prepareHarnessContextMedia`, lines 13–56):
  reads persisted media facts off the user message, loads image blocks via
  `detectAndLoadPromptImages`, and injects them when `params.modelInput.includes("image")`.
  When the model does **not** support image input it emits
  `"[Attachment images omitted: this model does not support image input]"`.
- Host `MediaUnderstandingRuntime` (`agent-harness-runtime-DaJ4mxKg.d.ts` ~line
  23410–23470) provides `describeImageFile`, `describeVideoFile`,
  `transcribeAudioFile`, `extractStructuredWithModel` — the host can produce
  descriptions/transcripts itself.

**Answer to the plan's question (2).** The host **does** carry media into the main
agent turn natively (vision-capable model path). The human-engine plugin itself,
however, does **not** forward `event.media`/`images` into any agent-run it triggers —
see §1.4. And the `before_agent_reply` hook event (`PluginHookBeforeAgentReplyEvent`,
`hook-runner-global-DZetem8r.d.ts:679-680`) carries **only `{ cleanedBody: string }`**
— no media. So at decide time the plugin has only the body + the cached media kind.

**Open question / live-test suggestion (unresolved in this spike):** whether the
*full* original media payload (with caption text + the image bytes the main agent
could vision-read) is actually delivered to the agent turn for the hori-wa WhatsApp
surface. Host types say it *can* be; live confirmation requires a host-side test
(see §5, verification suggestion) — flagged as the plan's STOP-acceptable outcome.

### 1.4 Current plugin behavior (evidence)

- `lib/gate.js:26-35` `detectInboundMedia` reads `event.media || event.originalMedia`,
  maps `kind` → marker via `SDK_KIND_TO_PLACEHOLDER` (`lib/gate.js:20-24`:
  image→`[image]`, video→`[video]`, audio→`[audio]`, document→`[document]`,
  sticker→`[sticker]`, voice→`[voice message]`), fallback `[media]`.
- `lib/gate.js:209-212` (`onMessageReceived`): caches `{hasMedia, mediaKind, marker}`
  into `state.mediaBySession`.
- `lib/gate.js:243-268` (`onBeforeAgentReply`): reads `cleanedBody` as prompt and the
  cached media; `displayText = prompt || marker`; passes `hasMedia`/`mediaKind` into
  decide.
- `lib/gate.js:129-131` (`resolveTranscript`): media-only (empty body) →
  `current.text = media.marker`.
- Decide prompt (`lib/local-prompts.js:207`): „Media messages (photos, voice notes)
  appear as [image]/[voice message] markers. React only when the media clearly
  concerns the group…".
- `estimateReadMs` (`lib/local-engine.js:136-141`): adds a flat **1500 ms** for any
  media marker line in the transcript.

**Gap vs. the host's caption body:** the plugin already has the caption *in the
prompt body* when a caption exists (host folds it into `cleanedBody`). It is **not**
currently rendered into the transcript line with a marker — a media-only message
with a caption shows only the body text; a media-only message without a caption
falls back to `[marker]`. There is **no** `caption` field on the fact to pull from.

---

## 2. Live-Verkehr messen (PII-safe)

Source: `/home/openclaw/human-engine/state/observed/*.jsonl` (the LIVE main-checkout
state; worktree has no `state/`). Read-only counts only; no message content or names
copied into this report.

Method: node one-liner — per file, count total parsed lines and lines whose parsed
`text` is **exactly** one of `[image] [video] [audio] [document] [sticker]
[voice message] [media]`.

| File | total lines | media lines | media % | per-kind counts |
|------|------------:|------------:|--------:|-----------------|
| `agent_hori-wa-public-group-kletter_whatsapp_group_120363426217608816_g_us.jsonl` | 332 | 0 | 0.0% | {} |
| `agent_hori-wa-public-group_whatsapp_group_4917624677323-1564511883_g_us.jsonl` | 53 | 0 | 0.0% | {} |
| `agent_hori-wa_telegram_direct_968721694.jsonl` | 11 | 0 | 0.0% | {} |

All files parsed cleanly (0 unparsed lines). Structure sanity: files have 1, 4, and 5
unique speaker fields respectively.

**Result: 0 media-marker lines across all observed files.** This is **consistent with
the code path**, not necessarily "no media ever": the observed store only receives
rows from `markStaySilent` → `persist()` (`lib/gate.js:160-162`), which writes
`text: prompt` (the body), and `appendObserved` **skips rows with empty text**
(`lib/observed-store.js:39` `if (!sessionKey || !row || !row.text) return;`). So
media-only messages with no caption (empty `cleanedBody`) are **never persisted** —
the observed store is not a reliable census of media volume. This is itself a finding
(§4).

---

## 3. Entscheidungsmatrix + kleinste-Änderung-Vorschlag

| Fund (evidence) | Kleinste sinnvolle Änderung | Effort | Kosten/Risiko |
|-----------------|-----------------------------|--------|---------------|
| Caption arrives in the **message body** (`cleanedBody`), not as a media-fact field — host folds caption+notice into body (`run-channel-turn-CxpIl7IS.mjs:39-44`); `MessageHookMediaFact` has **no** `caption` field (`hook-runner-global-DZetem8r.d.ts:190-197`) | Render caption into the transcript line when media+body present: marker with caption, e.g. `[image: <caption>]`, in `resolveTranscript`/`onBeforeAgentReply`; keep body for the decide prompt. No new LLM call | **S** | Zero extra cost; pure prompt-shaping. Watch token growth only. |
| Main agent turn is vision-capable **host-side** (`AgentCommandOpts.images`, `context-media-runtime-GGMM19zz.mjs`), but **plugin does not forward media** and `before_agent_reply` carries only `cleanedBody`; not yet live-confirmed for hori-wa surface | If host truly delivers original media to the agent turn, **only** sharpen the Decide-Prompt („the group will see the photo; judge by thread context") and weight `estimateReadMs` by `mediaKind` instead of flat 1500 ms | **S** | Zero LLM cost; risk only of over/under-reacting, mitigated by existing fail-closed gate |
| Media-only without caption → plugin marker fallback; observed store **drops** these rows | (Optional, S) persist a `[media:<kind>]` row into observed store so silence rationale/volume is measurable; not strictly needed for decide | **S** | Negligible |
| Host transcription: `MediaUnderstandingRuntime.transcribeAudioFile` exists; `transcribed?: boolean` on fact; transcript folds into body | Analog caption path — transcript already reaches decide via body when delivered; no extra work now | **S** | None beyond what host already does |
| Vision-spike via own LLM description (if host does NOT deliver media to turn) | Build own `describeImageFile`-style pipeline / OpenRouter description; inject as caption | **M/L** | **+1 LLM call / media message**, Decide-path latency risk, cost per message. **Consciously NOT building now.** |

### Empfehlung

1. **Adopt the caption-in-body path** (S): media messages with a caption already carry
   it in `cleanedBody`; make the transcript line carry a readable marker+caption so the
   decide prompt sees context. No extra LLM calls, zero latency.
2. **Before any vision work**: run the live host-side check (§5) to confirm whether the
   main agent turn actually receives the original media. If yes → only prompt/timing
   sharpening needed; the expensive Vision pipeline is unnecessary.
3. **Do not** build a Vision/transcription LLM pipeline now (M/L) — cost + Decide-path
   latency, and the host already exposes `describeImageFile`/`transcribeAudioFile`.

### Follow-up plan draft (next free slot: **033**)

> Coordination note: plan 031's report does not yet exist in the worktree (its own
> spike is still open), so 033 is free; 034 is reserved as fallback if 033 gets taken.

**Plan 033 — Media caption-in-body + kind-weighted read time (S, build).**

- Goal: make the decide path see media context without new LLM calls.
- Changes:
  1. `lib/gate.js` `resolveTranscript`/`onBeforeAgentReply`: when media present and
     body non-empty, render transcript line as `[<kind>: <body>]` (or `[<kind>]` when
     body empty), preserving body for the decide prompt.
  2. `lib/local-engine.js` `estimateReadMs`: weight by `mediaKind` (e.g. image > voice
     transcript > sticker) instead of flat 1500 ms.
  3. `lib/observed-store.js`: stop dropping media-only rows (persist a `[media:<kind>]`
     row) so silence rationale and media volume are measurable.
- Tests: marker/caption rendering, kind-weighted read-time, observed-store media row
  persistence. Parity rows appended.
- Out of scope: Vision pipeline, TTS (Plan 548b), live config changes.

---

## 4. Additional findings

- **Observed store undercounts media**: media-only messages (no caption → empty body)
  are silently skipped (`lib/observed-store.js:39`). The 0% measured in §2 therefore
  reflects a data-capture gap, not proof the group never shares media.
- **Marker token set differs between files**: `lib/gate.js:20-24` includes `voice`
  → `[voice message]`; `lib/messages.js:3-9` `MEDIA_PLACEHOLDERS` maps `photo→[image]`,
  `voice→[voice message]` etc. Both are consistent for counting purposes, but the
  plugin-local mapping is `kind`-driven (from `MediaKind`) while `messages.js` is
  `mediaType`-driven — a minor duplication worth unifying in the follow-up.

---

## 5. Verification summary (this session)

- `npm test` (worktree, symlinked SDK): **1084 pass / 0 fail**, parity **77/77**,
  exit 0. (Run 2026-09-10.)
- `git status --short` — no modifications under `lib/` or `test/` (only untracked
  root `node_modules`, the SDK shim). Production code **diff-free** in the worktree
  commits.
- Host SDK types read from `/home/openclaw/.npm-global/lib/node_modules/openclaw/dist/`
  (file:line cited in §1). The worktree shim lacks these types — documented gap with
  the above as the verification suggestion (host-side check).
- Live observed-store counts read from `/home/openclaw/human-engine/state/observed/`
  (counts + structure only; PII-safe). Nothing written under that tree.

### Host-side live verification suggestion (for the follow-up / reviewer)

To settle question (2) definitively: on the hori-wa WhatsApp surface, capture a real
media message and inspect (a) whether `before_agent_reply`'s `cleanedBody` contains the
caption or the "unavailable media" notice, and (b) whether the main agent turn's
transcript/prompt contains the original image (vision) or the omission marker. This
determines whether the Vision pipeline is ever needed.
