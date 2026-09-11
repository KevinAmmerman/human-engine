const DISCORD_PLACEHOLDER = "(The user sent a message with no text content)";

const MEDIA_PLACEHOLDERS = {
  photo: "[image]",
  video: "[video]",
  voice: "[voice message]",
  audio: "[audio]",
  document: "[document]",
  sticker: "[sticker]",
};

export const MEDIA_PLACEHOLDER_SET = new Set(Object.values(MEDIA_PLACEHOLDERS));

const SENDER_CAP = 255;
const CONTENT_CAP = 4000;
const MAX_MESSAGES = 20;

export function isCommand(text) {
  if (typeof text !== "string") return false;
  return text.trimStart().startsWith("/");
}

const QUOTED_AUDIO_CAP = 2000;

export const QUOTED_CONTEXT_MARKER = "[quoted earlier message (context, not the current ask):]";

// Host media pipeline may attach a quoted voice transcript like
// "[Audio]\nUser text:\n<U>\nTranscript:\n<T>". Split it so the quoted part
// can be labelled as context instead of masquerading as the current ask.
// Returns { userText, quotedTranscript }; when the labelled pattern is absent,
// the whole input is userText and quotedTranscript is empty. Both capped.
export function splitQuotedAudioBody(text) {
  const s = String(text ?? "");
  const transcriptIdx = s.lastIndexOf("Transcript:");
  const userTextIdx = transcriptIdx >= 0 ? s.lastIndexOf("User text:", transcriptIdx) : -1;
  if (transcriptIdx < 0 || userTextIdx < 0) {
    return { userText: s.slice(0, QUOTED_AUDIO_CAP), quotedTranscript: "" };
  }
  const userText = s.slice(userTextIdx + "User text:".length, transcriptIdx).trim().slice(0, QUOTED_AUDIO_CAP);
  const quotedTranscript = s.slice(transcriptIdx + "Transcript:".length).trim().slice(0, QUOTED_AUDIO_CAP);
  return { userText, quotedTranscript };
}

// Canonical model-facing form of a transcript body: a quoted-audio body becomes
// "<userText>\n<marker> <quotedTranscript>"; anything else is returned unchanged.
// Idempotent, so it is safe to apply to already-labelled lines during dedup.
export function normalizeQuotedAudioBody(text) {
  const { userText, quotedTranscript } = splitQuotedAudioBody(text);
  if (!quotedTranscript) return String(text ?? "");
  return userText + "\n" + QUOTED_CONTEXT_MARKER + " " + quotedTranscript;
}

export function toServiceMessages(events) {
  const out = [];
  for (const ev of events) {
    let content = (ev.text || "").trim();
    const hasMedia = ev.hasMedia === true;
    const mtype = ev.mediaType || "";

    if (hasMedia && content === DISCORD_PLACEHOLDER) {
      content = "";
    }
    if (!content) {
      if (!hasMedia) continue;
      content = MEDIA_PLACEHOLDERS[mtype] || "[media]";
    }
    let sender = ev.senderName || "Unknown";
    if (ev.mentions && ev.mentions.length > 0) {
      for (const m of ev.mentions) {
        const repl = m.isSelf ? "@you" : `@${m.displayName || m.id}`;
        const escapedId = m.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        content = content.replace(new RegExp(`<@${escapedId}>`, "g"), repl);
        content = content.replace(new RegExp(`<@!${escapedId}>`, "g"), repl);
      }
    }
    const msg = {
      sender: sender.slice(0, SENDER_CAP),
      content: content.slice(0, CONTENT_CAP),
    };
    if (hasMedia) msg.has_media = true;
    out.push(msg);
  }
  return out.slice(-MAX_MESSAGES);
}
