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
