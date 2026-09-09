# Plan 003: Identity-Consumer pro Agent umstellen (Name, Aliases, Contacts, Soul, Self-Filter)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git -C ~/human-engine diff --stat e9216df..HEAD -- lib/ index.js test/`
> On mismatch with the "Current state" excerpts (beyond Plan 001/002's own
> changes): STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED (Identity-Matching ist verhaltenskritisch: Hard-Trigger, Own-Reply-Attribution, Self-Filter; Fehler = Agent antwortet falsch oder nie)
- **Depends on**: plans/001-canonical-scope-parser.md, plans/002-agent-profiles-config.md
- **Category**: migration
- **Planned at**: commit `e9216df`, 2026-09-09

## Why this matters

Nach 002 existiert `resolveAgentConfig(cfg, agentId)`, aber KEIN Consumer
nutzt es: Alle Identity-Stellen lesen weiterhin das globale
`cfg.agentName`/`cfg.agentAliases`/`cfg.contactsPath`/`cfg.soulPath`. Ein
zweiter Agent läuft dadurch unter Yuki's Namen, mit Yuki's Contact-Tabelle
und Yuki's SOUL — und umgekehrt würde `/soul enhance` die kuratierte
Yuki-SOUL.md cross-mutieren. Dieser Plan stellt JEDEN Identity-Consumer
auf die pro-Agent-Auflösung um — das ist der Plan, der Multi-Tenancy
tatsächlich sichtbar macht. Verifiziert wird per E2E (Zwei-Agenten-Pipeline)
plus den bestehenden Suiten.

## Current state

Alle Zitate verifiziert bei `e9216df` (falls Plan 001/002 schon gemerged:
deren Änderungen an gate.js imports / config.js sind erwartet; alle hier
gezeigten Identity-Stellen bleiben unverändert davon).

Identity-Konsumstellen (VOLLSTÄNDIGE Liste — `grep -n "agentName\|agentAliases\|contactsPath\|soulPath" lib/*.js index.js bin/*.mjs` ist der Check):

1. `lib/gate.js`:
   - :54 `resolveSender` → `loadContacts(cfg.contactsPath)` (globale Tabelle)
   - :152 `socialMemory.recall(scope, [senderName, cfg.agentName || "Agent"])`
   - :238 `const agentContactIds = findAgentContactIds(loadContacts(cfg.contactsPath), cfg.agentName, cfg.agentAliases);`
   - :262-279 Quote-Reply-Erkennung:
     ```js
     if (quotedName && cfg.agentName && quotedName.toLowerCase().startsWith(cfg.agentName.toLowerCase())) {
       replyToAgent = true;
     } else if (replyCtx.body) {
       const ownPrefix = "[" + (cfg.agentName || "Agent") + "] ";
       …
       cfg.agentName && transcriptLines.some((l) => { const speaker = String(l.speaker || ""); return speaker.toLowerCase().startsWith(cfg.agentName.toLowerCase()) && …; });
     ```
   - :318 `hasHardTrigger(prompt, messages, cfg.agentName, agentContactIds, cfg.agentAliases)`
   - :341-343 `const ownNames = [cfg.agentName, ...(cfg.agentAliases || [])].map(…)` (decide-ctx own-count)
   - :359-360 `engine.decide({ …, agentName: cfg.agentName, agentAliases: cfg.agentAliases, … })`
2. `lib/naturalize.js` (per grep bei e9216df exakt 5 Stellen):
   - :170 `speaker: cfg.agentName || "Agent",` (persistOwnReply)
   - :242 `pushTranscriptPeek(sk, "[" + (cfg.agentName || "Agent") + "] " + text.slice(0, 300), …)`
   - :330 `socialMemory.ingest(scope, { speaker: cfg.agentName || "Agent", text: draft, … })`
   - :351 `agentName: cfg.agentName,` (humanize-Prompt)
   - :376 `agentName: cfg.agentName,` (raw-Pfad)
3. `lib/persona.js`:
   - :9 `const soulCache = { path: null, mtime: 0, content: null };` — SINGLE-SLOT
   - :11-27 `readSoul(soulPath)` nutzt diesen Slot; :37/:42 `buildSoulPrompt(cfg)`/`buildPersonaPrompt(cfg, sessionKey)` nehmen cfg als Parameter — sie bekommen per-agent cfg automatisch, SOBALB die Aufrufer sie übergeben; der Cache ist der einzige Code-Fix.
4. `lib/contacts.js`:
   - :3 `const cache = { path: null, mtime: 0, map: new Map() };` — SINGLE-SLOT; ab 2 Agenten mit verschiedenen contactsPath thrashen die Agenten sich gegenseitig aus dem Cache (statSync+mtime-Check pro Aufruf, aber immer nur EINE Datei gehalten).
5. `lib/social-memory.js`:
   - :40-47 `isSelfName(cfg, name)` mit globalem `cfg.agentName`/`cfg.agentAliases`; aufgerufen in `getOrLoadProfile` (:82) — Profilk_cleanup filtert "self"-Namen nur gegen den GLOBALEN Namen → 2. Agent's Name landet als "Person" im Profil.
6. `lib/soul.js`:
   - :42-44 `resolveSoulPath(cfg) { return cfg.soulPath || path.join(os.homedir(), ".openclaw", "SOUL.md"); }` — cfg-Param da, per-agent automatisch; `/soul enhance` (index.js:169-181) und `maybeAutoEnhance` (soul.js:80+) müssen pro Agent aufgelöst werden.
7. `lib/dm-proactive.js`:
   - :85 `const agentName = cfg?.agentName || "Agent";` — bei create gefroren; weiter unten als ctx.agentName in `evaluateDmGate` (double-text-Regel).
8. `lib/dm-gate-core.js`:
   - :186 `check("double-text", !(typeof ctx?.newestSpeaker === "string" && ctx.newestSpeaker === ctx?.agentName));` — vergleicht gegen den übergebenen ctx.agentName (Fix passiert im Aufrufer, dm-proactive).
9. `index.js`:
   - :105 `resolveTranscriptSpeaker(role, msg, cfg.agentName || "Agent")` in `readSessionTranscript`.
   - :169-181 `/soul`-Command → `enhanceAndWrite(cfg, engine)`.
10. `bin/followup-gate.mjs:121` (per Plan-586-Blueprint, Zitat): `newestSpeaker: null` + globaler `agentName` — bekommt per-agent cfg in Plan 005 (CLI-Tenancy), hier NICHT anfassen.

Konventionen: Log-Präfix `human-engine:`; `wrap()` fängt Fehler
(fail-open DM / fail-closed group — NICHT ändern); Tests node:test mit
inline fakes; E2E-Muster: `test/e2e-local.test.js` (Hook-Pipeline mit
fake engine/dispatcher, sessionKey `agent:test:whatsapp:group:e2e@g.us`
— FAKE-Werte, Repo ist PUBLIC).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Tests | `cd ~/human-engine && npm test` | all pass, 0 fail |
| Parity | `cd ~/human-engine && node test/parity-matrix.mjs --check` | `51/51 covered`, exit 0 |
| Identity-Grep | `cd ~/human-engine && grep -n "cfg.agentName\|cfg.agentAliases\|cfg.contactsPath\|cfg.soulPath" lib/*.js index.js` | nur noch Stellen mit lokalem per-agent cfg (siehe Step-Verify) |

## Scope

**In scope**:
- `~/human-engine/lib/contacts.js` (Cache-Slot → Map)
- `~/human-engine/lib/persona.js` (soulCache-Slot → Map)
- `~/human-engine/lib/gate.js` (Identity-Stellen per-agent)
- `~/human-engine/lib/naturalize.js` (5 Stellen)
- `~/human-engine/lib/social-memory.js` (isSelfName pro scope-agentId)
- `~/human-engine/lib/dm-proactive.js` (:85 + evaluateDmGate-ctx per-agent)
- `~/human-engine/lib/soul.js` (nur falls nötig — resolveSoulPath nimmt bereits cfg)
- `~/human-engine/index.js` (readSessionTranscript-Speaker, /soul-Command)
- `~/human-engine/test/gate.test.js`, `test/naturalize.test.js`, `test/social-memory.test.js`, `test/persona.test.js`, `test/contacts.test.js`, `test/e2e-local.test.js` (neue Cases)

**Out of scope**:
- `bin/followup-gate.mjs` (Plan 005), `lib/dm-gate-core.js` (Regel bleibt ctx-getrieben)
- `lib/voice-card.js` (Plan 004 — Getter-Signatur ändert sich erst dort; dieser Plan darf persona.js NICHT so ändern, dass voice-card bricht)
- `lib/proactive.js` (Plan 005), State-Keying überall
- Live-Config `~/.openclaw/openclaw.json` (Operator entscheidet nach deploy)

## Git workflow

- Branch: `advisor/003-per-agent-identity`
- Commit pro Step; Stil wie `git log --oneline` (`plan 003: …`).
- NICHT pushen/mergen ohne Operator-Anweisung. PUBLIC repo — fake
  Namen/IDs in Tests (`AgentB`, `agent-b`, `999999999`).

## Steps

### Step 1: contacts.js — Cache als Map

```js
const cacheByPath = new Map(); // path -> { mtime, map }

export function loadContacts(filePath) {
  if (!filePath) return null;
  try {
    const st = fs.statSync(filePath);
    const hit = cacheByPath.get(filePath);
    if (hit && hit.mtime === st.mtimeMs) return hit.map;
    const map = parseContacts(fs.readFileSync(filePath, "utf8"));
    cacheByPath.set(filePath, { mtime: st.mtimeMs, map });
    if (cacheByPath.size > 32) cacheByPath.delete(cacheByPath.keys().next().value);
    return map;
  } catch {
    return null;
  }
}
```

**Verify**: `node --test test/contacts.test.js` → pass; neue Cases:
zwei verschiedene Pfade liefern zwei Maps (kein Thrash); gleicher Pfad +
neue mtime → reload.

### Step 2: persona.js — soulCache als Map

`soulCache` → `const soulCacheByPath = new Map(); // path -> { mtime, content }`
mit identischer TTL/mtime-Logik pro Pfad (Muster wie Step 1). buildSoulPrompt/
buildPersonaPrompt UNVERÄNDERT lassen (nehmen cfg) — voice-card-Getter-
Signatur (Z. 45 `voiceCardGetter(sessionKey)`) NICHT anfassen (Plan 004).

**Verify**: `node --test test/persona.test.js` → pass; neuer Case:
zwei soulPaths liefern zwei Inhalte im selben Prozess.

### Step 3: gate.js — per-agent Auflösung

In `onBeforeAgentReply` (und `onMessageReceived` für resolveSender) EINMAL
am Anfang nach dem Scoping:
```js
const agentCfg = resolveAgentConfigForSession(cfg, sk, ctx?.agentId);
const agentIdentity = {
  name: agentCfg.agentName || "Agent",
  aliases: Array.isArray(agentCfg.agentAliases) ? agentCfg.agentAliases : [],
  contactsPath: agentCfg.contactsPath || "",
};
```
(Import aus `./config.js`; sessionKey-Helfer aus `./scope.js` — Plan 001.)
Dann ALLE cfg.agentName/agentAliases/contactsPath-Vorkommen im
`onBeforeAgentReply`-Scope (Z. 54 via resolveSender — resolveSender bekommt
contactsPath als Parameter; :152, :238, :262-279, :318, :341-343, :359-360)
durch die agentIdentity-Werte ersetzen. resolveSender-Signatur:
`resolveSender(contactsPath, ...candidates)`; Aufrufer in
onMessageReceived (Z. 173) und onBeforeAgentReply (Z. 223, 391) leiten
per-agent Pfad weiter. `markSpeak` (:152): agentName als Parameter
reinhreichen (Aufrufstellen :301, :325).

**Verify**: `npm test` → all pass; Identity-Grep → in gate.js KEIN
`cfg.agentName`/`cfg.contactsPath` mehr außer der resolveAgentConfigForSession-Zeile.

### Step 4: naturalize.js + social-memory.js + dm-proactive.js + index.js

1. naturalize.js: an denselben 5 Stellen (:170, :242, :330, :351, :376)
   per-agent: `const agentCfg = resolveAgentConfigForSession(cfg, sk, ctx?.agentId);`
   am Handler-Anfang, dann `agentCfg.agentName` statt `cfg.agentName`
   (:351/:376: `agentName: agentCfg.agentName`).
2. social-memory.js: `isSelfName(cfg, name, agentId)` — Auflösung gegen
   `resolveAgentConfig(cfg, agentId)`; Aufruf in `getOrLoadProfile` (Z. 82):
   `isSelfName(cfg, name, parsed?.agentId)` (parsed aus parseScope(scope),
   Z. 77 bereits vorhanden).
3. dm-proactive.js: :85 entfernen; an jeder `evaluateDmGate`-Aufrufstelle
   `ctx.agentName` pro-agent setzen: `agentName:
   resolveAgentConfig(cfg, agentId).agentName || "Agent"` (grep `agentName`
   in dm-proactive.js — zwei Verwendungen: shadow-live gate ctx).
4. index.js: :105 — `resolveTranscriptSpeaker(role, msg, resolveAgentConfig(cfg,
   agentIdFromSessionKey(sessionKey))?.agentName || cfg.agentName || "Agent")`
   (sessionKey ist im Scope; agentId-Variablenname dort beachten). /soul
   (Z. 169-181): `enhanceAndWrite(resolveAgentConfig(cfg, ctx?.agentId), engine)`
   — wenn der Command-ctx KEIN agentId trägt: global lassen (heuristisch ok,
   dokumentieren) und STOP-condition-Bullet unten beachten.

**Verify**: `npm test` → all pass; Identity-Grep: nur noch erwartete Reste
(config.js selbst, Fallback-"Agent"-Defaults über agentCfg).

### Step 5: E2E — Zwei-Agenten-Pipeline (DER Zuverlässigkeitsanker)

In `test/e2e-local.test.js` (Muster: bestehender describe „speak → split →
timed delivery" — gleiche fakes) einen neuen describe „multi-agent
isolation":

1. cfg mit `agents: ["agent-a", "agent-b"]` + `agentProfiles: { "agent-a":
   { agentName: "Alice", contactsPath: <fakeA>, soulPath: <fakeA> }, "agent-b":
   { agentName: "Bob", contactsPath: <fakeB>, soulPath: <fakeB> } }`
   (per resolveConfig bauen; Fake-Kontakt-Files in tmp-Dir: Kontakt-ID
   `999000001` = „Alice", `999000002` = „Bob").
2. **Case A — Hard-Trigger-Trennung**: message in agent-b's Gruppe
   (`agent:agent-b:whatsapp:group:1@g.us`) mit Text „hey Alice" → KEIN speak
   (Alice ist nicht agent-b's Name); Text „hey Bob" → speak path=hard.
3. **Case B — Quote-Reply-Erkennung pro Agent**: quote auf Alice's eigene
   Nachricht in agent-a's Gruppe → replyToAgent true für agent-a, false
   für agent-b.
4. **Case C — Persona/SOUL pro Agent**: before_agent_reply mit agent-a
   → decide-Persona enthält fakeA-SOUL-Inhalt; agent-b → fakeB.
5. **Case D — Self-Filter**: social-memory ingest einer assistant-Zeile
   „Alice" in agent-a's Scope → Alice-Name ist KEIN people-Eintrag; „Bob"
   in agent-a's Scope IST Eintrag.

**Verify**: `node --test test/e2e-local.test.js` → all pass inkl. neuer
Cases; `npm test` → all pass; Parity 51/51.

### Step 6: Parität + Dokumentation

1. `node test/parity-matrix.mjs --check` → 51/51 (wenn eine Row die
   Global-Identity asserts: Row-Text prüfen, NICHT schummeln — Verhalten
   ohne agentProfiles ist unverändert, Rows sollten grün bleiben).
2. Repo-Wiki `wiki/operations/environment.md`: Abschnitt „Per-agent
   profiles (Plan 002/003)" — Keys, Auflösungsreihenfolge, Beispiel.

**Verify**: wie oben; `grep -n "agentProfiles" wiki/operations/environment.md` → Treffer.

## Test plan

- Neu: e2e multi-agent describe (Step 5, 4 Cases); contacts/persona
  Multi-Path-Cases (Steps 1-2); gate.test.js Cases: pro-agent
  contactsPath-Auflösung (Muster: Z. 943-953 Name-Resolution-Test),
  Hard-Trigger mit falschem Namen → stay_silent.
- Regression: ALLE bestehenden Tests unverändert grün (Backward-Compat:
  kein Profil = exakt heutiges Verhalten).
- Verification: `npm test` all pass; Parity 51/51.

## Done criteria

- [ ] Identity-Grep zeigt keine globalen `cfg.agentName|agentAliases|contactsPath|soulPath`-Verwendungen mehr in gate.js/naturalize.js/dm-proactive.js/social-memory.js (nur resolver-basierte)
- [ ] contacts.js + persona.js Caches sind Map-keyed (Multi-Path-fähig)
- [ ] E2E multi-agent describe grün (4 Cases)
- [ ] `npm test` exit 0; Parity 51/51
- [ ] `git status` zeigt nur In-Scope-Dateien
- [ ] `plans/README.md` Status-Row aktualisiert

## STOP conditions

- Code-Ausschnitte stimmen nicht mehr (Drift über 001/002 hinaus).
- Bestehender Test muss INHALTLICH geändert werden, um grün zu werden
  (Import-Fixes sind ok) — dann hast du ein Verhaltens-Delta gebaut:
  stoppen, Delta beschreiben.
- Der `/soul`-Command-ctx trägt NUR einen global agnostischen Kontext und
  eine per-agent Auflösung wäre eine Neu-Erfindung — melden statt raten.
- Eine Parity-Row bricht: Row-Text + Bruch beschreiben; NICHT die Row
  löschen oder das Verhalten zurückpatchen, um sie grün zu machen.

## Maintenance notes

- Nach diesem Plan kann der Operator Agenten in `agentProfiles` anlegen —
  ONBOARDING ist danach rein deklarativ (Runbook entsteht in Plan 006).
- Reviewer-Schwerpunkt: (a) resolveSender-Signaturänderung an ALLEN
  Aufrufstellen, (b) Quote-Reply-Erkennung (Incident-Klasse 342-346),
  (c) dass voice-card-Getter-Signatur NICHT angeraten wurde.
- Bekannte Lücke (bewusst): `bin/followup-gate.mjs` + sentIds/byKind
  bleiben global bis Plan 005; DayFit bleibt single-human bis Plan 005.
