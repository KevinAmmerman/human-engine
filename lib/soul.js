import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const NO_EMDASH_DIRECTIVE = "\n\nHARD RULE: never use an em-dash (\u2014) anywhere in this persona.";

export function seedBody(raw) {
  const noComments = (raw || "").replace(/<!--[\s\S]*?-->/g, "");
  return noComments
    .split("\n")
    .filter((ln) => !ln.trim().startsWith("#"))
    .join("\n")
    .trim();
}

export function personaText(raw) {
  return (raw || "").replace(/<!--[\s\S]*?-->/g, "").trim();
}

function resolveSoulPath(cfg) {
  return cfg.soulPath || path.join(os.homedir(), ".openclaw", "SOUL.md");
}

function resolveMarkerPath(cfg) {
  const soulPath = resolveSoulPath(cfg);
  return path.join(path.dirname(soulPath), ".soul_auto_enhanced");
}

export async function enhanceAndWrite(cfg, engine) {
  const soulPath = resolveSoulPath(cfg);
  let raw;
  try {
    raw = fs.readFileSync(soulPath, "utf8");
  } catch {
    raw = "";
  }

  if (!seedBody(raw)) {
    return "Your SOUL.md has no persona to enhance yet \u2014 add a few lines describing your agent, then send /soul enhance. (Generating one from scratch is coming soon.)";
  }

  const personaToSend = personaText(raw) + NO_EMDASH_DIRECTIVE;
  const result = await engine.enhancePersona({ persona: personaToSend });
  const enhanced = result?.system_prompt;
  if (!enhanced) {
    return "\u26a0\ufe0f Couldn\u2019t reach the persona service \u2014 SOUL.md left unchanged.";
  }

  const trimmed = enhanced.trim();
  try {
    fs.writeFileSync(soulPath + ".bak", raw, "utf8");
    fs.writeFileSync(soulPath, trimmed + "\n", "utf8");
  } catch (err) {
    return "\u26a0\ufe0f Enhanced, but couldn\u2019t write " + soulPath + ": " + err.message;
  }

  return "\u2705 Enhanced your persona (" + raw.length + " \u2192 " + trimmed.length + " chars). Old version saved to " + path.basename(soulPath) + ".bak \u2014 it takes effect on your next message.";
}

async function autoEnhance(cfg, engine) {
  const soulPath = resolveSoulPath(cfg);
  let raw;
  try {
    raw = fs.readFileSync(soulPath, "utf8");
  } catch {
    raw = "";
  }

  if (!seedBody(raw)) return false;

  const personaToSend = personaText(raw) + NO_EMDASH_DIRECTIVE;
  const result = await engine.enhancePersona({ persona: personaToSend });
  const enhanced = result?.system_prompt;
  if (!enhanced) return false;

  const trimmed = enhanced.trim();
  try {
    fs.writeFileSync(soulPath + ".bak", raw, "utf8");
    fs.writeFileSync(soulPath, trimmed + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

export function maybeAutoEnhance(cfg, engine) {
  if (cfg.soulAutoEnhance === false) return;
  const markerPath = resolveMarkerPath(cfg);
  if (fs.existsSync(markerPath)) return;

  setTimeout(async () => {
    try {
      if (await autoEnhance(cfg, engine)) {
        try {
          fs.writeFileSync(markerPath, "", "utf8");
        } catch {}
      }
    } catch {}
  }, 0);
}
