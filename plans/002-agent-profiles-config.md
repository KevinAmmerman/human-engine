# Plan 002: Per-Agent-Config-Profile (`agentProfiles`) — Schema, Defaults, Resolver

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git -C ~/human-engine diff --stat e9216df..HEAD -- lib/config.js openclaw.plugin.json test/config.test.js`
> On mismatch with the "Current state" excerpts: STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW (rein additiv — ohne `agentProfiles` verhält sich alles exakt wie heute)
- **Depends on**: plans/001-canonical-scope-parser.md (nutzt `agentIdFromSessionKey` für den Fallback-Resolver)
- **Category**: migration
- **Planned at**: commit `e9216df`, 2026-09-09

## Why this matters

`agents` ist heute nur eine Allowlist (lib/config.js:106-111); die
Identität (`agentName`, `agentAliases`) und die Pfade (`contactsPath`,
`soulPath`) sind globale Singletons. Ein zweiter Agent läuft deshalb unter
dem einen globalen Namen. Dieser Plan schafft das CONFIG-MODELL für
Multi-Tenancy: `agentProfiles` — eine Map keyed by agentId, deren Einträge
die globalen Keys pro Agent übersteuern. Wer heute keinen Profile-Eintrag
hat, bekommt exakt das heutige Verhalten (Backward-Compat ist die
Härte-Voraussetzung). Die Consumer-Umstellung passiert in Plan 003; hier
wird nur Modell + Resolver + Schema + Tests gebaut.

## Current state

- `lib/config.js` (komplett gelesen, 111 Zeilen):
  ```js
  export function defaultConfig() {
    return {
      enabled: true,
      agents: [],
      agentName: "OpenClaw",
      agentAliases: [],
      soulPath: "",
      contactsPath: "",
      soulAutoEnhance: true,
      antiTell: true,
      styleStats: true,
      socialLearning: { enabled: true, perSessionCard: true, refreshEvery: 5, refreshMinutes: 0, window: 100, logRequests: false },
      socialMemory: { enabled: true, extractEvery: 25, extractMinutes: 0, maxPeople: 50, recallLimit: 800 },
      autoconfig: false,
      decide: { temperature: 0.2 },
      humanize: { maxBubbles: 5, temperature: 0.9 },
      timing: { typingWpm: 40, maxTypingMs: 60000, maxBubbleGapMs: 3000, nightMode: true },
      naturalize: { disableDM: false, speakEpochTtlMs: 300000 },
      proactive: { enabled: false, shadow: true, budgetPerDay: 2, recognitionBudgetPerDay: 1, minGapMinutes: 180, quietStart: "23:00", quietEnd: "07:00", probability: 0.5, cooldownBaseMinutes: 180, triggers: {…} },
      dmProactive: { enabled: false, shadow: true, budgetPerDay: 2, minGapMinutes: 180, quietStart: "23:00", quietEnd: "07:00", careBudgetPerDay: 1, dayFitReduceHours: 4, dayFitPauseHours: 12, inferredCapPerDay: 2 },
      mood: { enabled: false, refreshEvery: 5, refreshMinutes: 0, decayHours: 6, maxShiftPerUpdate: 1 },
    };
  }

  const NESTED_KEYS = ["socialLearning", "socialMemory", "decide", "humanize", "timing", "naturalize", "proactive", "dmProactive", "mood"];

  export function resolveConfig(api) {
    const overrides =
      api?.pluginConfig ??
      api?.config?.plugins?.entries?.["human-engine"]?.config ??
      {};
    const cfg = { ...defaultConfig(), ...overrides };
    for (const key of NESTED_KEYS) {
      if (overrides[key] && typeof overrides[key] === "object") {
        cfg[key] = { ...(defaultConfig()[key] || {}), ...overrides[key] };
      }
    }
    return cfg;
  }

  export function isEnabled(cfg) {
    return cfg.enabled === true;
  }

  export function isScopedAgent(cfg, agentId) {
    const { agents } = cfg;
    if (!Array.isArray(agents) || agents.length === 0) return true;
    if (typeof agentId !== "string" || agentId.length === 0) return false;
    return agents.includes(agentId);
  }
  ```
- `openclaw.plugin.json`: Root-`configSchema` ist `{"type":"object",
  "additionalProperties": false, "properties": {…}}` (Z. 9-12). Die
  Identity-Keys liegen flach: `agents` (array, Z. 14), `agentName` (Z. 15),
  `agentAliases` (Z. 16), `soulPath` (Z. 17), `contactsPath` (Z. 18).
  Ein Key, den das Schema nicht kennt, wird vom Host-Validator abgelehnt
  (Deploy-Order-Falle — siehe Maintenance notes; Muster: Plan 586 Step 5).
- Merge-Semantik (AGENTS.md): „one-level deep merge … A partial override
  never drops sibling defaults. The schema in openclaw.plugin.json is
  strict — keep it in sync with lib/config.js."
- `lib/proactive.js:77-80` exportiert `agentIdFromSessionKey` (wird in
  Plan 001 nach scope.js konsolidiert — dieser Plan importiert es aus
  `./scope.js` bzw. dem nach Plan 001 gültigen Pfad).
- Test-Konvention: `test/config.test.js` (isScopedAgent-Tests Z. 113-134,
  Merge-Tests Z. 30-63) baut cfgs teils per Hand — neue Tests MÜSSEN über
  `resolveConfig` laufen (das ist der Punkt dieses Plans).

Live-Config (Referenz, `~/.openclaw/openclaw.json` →
`plugins.entries["human-engine"].config`): `agents:
["hori-wa-public-group-kletter","hori-wa"]`, `agentName: "Yuki"`,
`agentAliases: ["Hori"]`, contactsPath/soulPath auf
`/srv/.../hori-wa-public-group-kletter/…` — exakt die Singletons, die
`agentProfiles` später pro Agent übersteuern wird.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Tests | `cd ~/human-engine && npm test` | all pass, 0 fail |
| Parity | `cd ~/human-engine && node test/parity-matrix.mjs --check` | `51/51 covered`, exit 0 |
| Resolver-Smoke | `node --input-type=module -e "import {resolveAgentConfig, defaultConfig} from './lib/config.js'; const cfg={...defaultConfig(), agentName:'Yuki', agentAliases:['Hori'], agentProfiles:{'agent-b':{agentName:'BotB', soulPath:'/tmp/b-soul.md'}}}; const a=resolveAgentConfig(cfg,'agent-b'); console.log(a.agentName, a.agentAliases, a.soulPath, a.contactsPath);"` | `BotB [ 'Hori' ] /tmp/b-soul.md ""` |

## Scope

**In scope** (die einzigen Dateien, die du änderst):
- `~/human-engine/lib/config.js`
- `~/human-engine/openclaw.plugin.json`
- `~/human-engine/test/config.test.js`

**Out of scope** (NICHT anfassen):
- ALLE Consumer (`gate.js`, `naturalize.js`, `persona.js`, `contacts.js`,
  `voice-card.js`, `social-memory.js`, `dm-proactive.js`,
  `dm-gate-core.js`, `proactive.js`, `mood.js`, `soul.js`, `index.js`) —
  die Umstellung ist Plan 003.
- `bin/followup-gate.mjs`.
- Live-Config `~/.openclaw/openclaw.json` — wird NICHT geändert (neuer
  Key wird nicht gesetzt; Schema-Erweiterung allein ist harmlos).

## Git workflow

- Branch: `advisor/002-agent-profiles-config`
- Commit pro Step; Stil: `plan 002: agentProfiles resolver` o. konventionell.
- NICHT pushen/mergen ohne Operator-Anweisung. Repo ist PUBLIC — keine
  echten Pfade mit Namen in Tests; `/tmp/…`-artige Fakes nutzen.

## Steps

### Step 1: `agentProfiles`-Default + `resolveAgentConfig` in `lib/config.js`

1. In `defaultConfig()` (nach `contactsPath`) ergänzen:
   ```js
   agentProfiles: {},
   ```
2. Am Dateiende (nach `isScopedAgent`) ergänzen:
   ```js
   // Plan 002: per-agent profile overlay. Resolution order per key:
   //   agentProfiles[agentId][key]  →  global cfg[key]  →  undefined
   // Nested objects inside a profile merge ONE level over the global
   // object (same semantics as resolveConfig's NESTED_KEYS), so a profile
   // override like { proactive: { shadow: false } } keeps the global
   // budgetPerDay default. The allowlist (cfg.agents) is NOT affected —
   // profiles only override values, they never widen scoping.
   const PROFILE_MERGE_KEYS = NESTED_KEYS;

   export function resolveAgentConfig(cfg, agentId) {
     if (!agentId || typeof agentId !== "string") return cfg;
     const profile = cfg?.agentProfiles?.[agentId];
     if (!profile || typeof profile !== "object") return cfg;
     const out = { ...cfg };
     for (const [k, v] of Object.entries(profile)) {
       if (PROFILE_MERGE_KEYS.includes(k) && v && typeof v === "object" && !Array.isArray(v)) {
         out[k] = { ...(cfg[k] || {}), ...v };
       } else {
         out[k] = v;
       }
     }
     return out;
   }

   // Convenience: resolve for a session context. Falls back to the global
   // cfg when the sessionKey carries no agentId (Plan 536-class contexts).
   export function resolveAgentConfigForSession(cfg, sessionKey, ctxAgentId) {
     return resolveAgentConfig(cfg, ctxAgentId || agentIdFromSessionKey(sessionKey));
   }
   ```
3. Import oben: `import { agentIdFromSessionKey } from "./scope.js";`
   (Plan 001; falls 001 noch nicht gemerged ist — STOP condition siehe
   unten. Plan 002 startet NACH 001.)

Achtung Kreisimport: `lib/scope.js` darf KEINEN Import auf config.js
bekommen (hat es per Plan 001 auch nicht) — Importrichtung ist
config.js → scope.js.

**Verify**: Resolver-Smoke aus der Tabelle → `BotB [ 'Hori' ] /tmp/b-soul.md ""`
(Profile übersteuert name+soulPath; Aliases/Pfade fallen auf global durch).

### Step 2: Schema-Key in `openclaw.plugin.json`

In `configSchema.properties` (alphabetisch nach `agents`, vor `agentName`)
ergänzen:

```json
"agentProfiles": {
  "type": "object",
  "additionalProperties": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "agentName": { "type": "string" },
      "agentAliases": { "type": "array", "items": { "type": "string" } },
      "contactsPath": { "type": "string" },
      "soulPath": { "type": "string" },
      "soulAutoEnhance": { "type": "boolean" },
      "socialLearning": { "type": "object" },
      "socialMemory": { "type": "object" },
      "proactive": { "type": "object" },
      "dmProactive": { "type": "object" },
      "mood": { "type": "object" },
      "naturalize": { "type": "object" },
      "timing": { "type": "object" },
      "humanize": { "type": "object" },
      "decide": { "type": "object" }
    }
  },
  "default": {}
}
```

(`additionalProperties` als SCHEMA auf einer Map ist die idiomatische
JSON-Schema-Form für freie Keys — das Repo nutzt das Muster erstmals,
deshalb hier explizit. Die Objekt-Subschemas {…} sind bewusst losgelassen;
Striktheit pro Profil-Feld wäre Nice-to-have, kein Muss dieses Plans.)

**Verify**: `node --input-type=module -e "const s = JSON.parse((await import('node:fs')).default.readFileSync('./openclaw.plugin.json','utf8')); console.log(typeof s.configSchema.properties.agentProfiles.additionalProperties)"` → `object`.

### Step 3: Tests in `test/config.test.js`

Neue `describe`-Blöcke (Muster: isScopedAgent-Tests Z. 113-134; ALLE cfgs
über `resolveConfig` bauen, nicht per Hand):

1. `defaultConfig().agentProfiles` deep-equal `{}`.
2. Merge: `resolveConfig({ pluginConfig: { agentProfiles: { "agent-b": { agentName: "BotB" } } } })` →
   `cfg.agentProfiles["agent-b"].agentName === "BotB"` UND die übrigen
   Global-Keys unangetastet.
3. `resolveAgentConfig`: Override siegt; Nicht-Profil-Keys fallen auf global
   durch; NESTED-Override mergt EINE Ebene über das Global-Objekt
   (`{ proactive: { shadow: false } }` im Profil → `shadow:false` UND
   `budgetPerDay: 2` überlebt).
4. `resolveAgentConfig` mit unbekannter/fehlender agentId → DAS GLEICHE
   cfg-Objekt (Identität, nicht Kopie) → Default-Verhalten.
5. `resolveAgentConfigForSession`: sessionKey `agent:agent-b:whatsapp:group:1@g.us`
   → Profil greift; sessionKey ohne agentId + ctxAgentId → greift;
   beides fehlend → global.
6. Profiles widen scoping NICHT: `agents: ["a"]` + Profil für `b` →
   `isScopedAgent(resolveAgentConfig(cfg,"b"), "b")` bleibt `false`.

**Verify**: `cd ~/human-engine && node --test test/config.test.js` → all
pass; danach `npm test` → all pass.

### Step 4: Parität

`node test/parity-matrix.mjs --check` → 51/51 (keine Zeile sollte sich
ändern — dieser Plan ist verhaltensneutral ohne Config-Nutzung des neuen
Keys).

**Verify**: wie oben.

## Test plan

- Neu: 6 Case-Gruppen in `test/config.test.js` (Step 3).
- Bestehende config-Tests müssen unverändert grün bleiben.
- Verification: `npm test` → all pass; Parity 51/51.

## Done criteria

- [ ] `resolveAgentConfig`/`resolveAgentConfigForSession` exportiert; Smoke-Ausgabe exakt
- [ ] `agentProfiles` im Schema (Strict-Validator lehnt NICHT ab — vgl. STOP 4)
- [ ] `npm test` exit 0; `node test/parity-matrix.mjs --check` → 51/51
- [ ] `git status` zeigt nur die 3 In-Scope-Dateien
- [ ] `plans/README.md` Status-Row aktualisiert

## STOP conditions

- Plan 001 (`lib/scope.js`) ist nicht im HEAD — dieser Plan hängt am
  Import. Erst 001 mergen.
- Der Resolver-Smoke liefert nach 2 Versuchen nicht die erwartete Ausgabe.
- Der Host lehnt das erweiterte Schema ab (schema validation error im
  Gateway-Log beim lokalen Plugin-Load-Test) — nicht improvisieren;
  validate-first-Variante (`"additionalProperties": {"type":"object"}` ohne
  innere Striktheit) nur nach Rücksprache.
- Ein bestehender Test bricht INHALTLICH (nicht importbedingt).

## Maintenance notes

- Deploy-Order-Falle (aus Plan 586 gelernt): Sobald die Live-Config
  `agentProfiles` setzt, MUSS der Plugin-Code mit diesem Schema schon
  deployed sein; und umgekehrt ist der neue Key harmlos, solange niemand
  ihn setzt. Deshalb: Code deployen, Config erst später.
- Plan 003 switcht die Consumer auf `resolveAgentConfigForSession`.
  Bis dahin liest alles weiter das globale cfg — der neue Key ist dead
  config (deshalb: Live-Config erst nach 003 umstellen).
- Reviewer-Schwerpunkt: (a) Allowlist-Semantik unverändert, (b)
  Backward-Compat (kein Profile-Eintrag = identisches Verhalten), (c)
  Merge-Ebene genau EINE (Hauskonvention).
- Later extension (out of scope): per-channel overrides (chatId-keyed)
  könnten als Unter-Key `channels` im Profil ergänzt werden — gleiche
  Merge-Mechanik, eigener Plan.
