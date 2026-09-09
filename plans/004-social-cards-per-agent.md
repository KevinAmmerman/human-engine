# Plan 004: Social Cards pro Agent — Voice-Card-Cache namespacen (per-agent Keys, Version-Feld, isolierte Eviction)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git -C ~/human-engine diff --stat e9216df..HEAD -- lib/voice-card.js lib/persona.js test/`
> On mismatch with the "Current state" excerpts (beyond Plan 002/003's own
> changes): STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (State-Format-Änderung mit Migration; Fehlmigration lernende Karten still verloren — fail-safe `catch {}` würde das verschweigen)
- **Depends on**: plans/002-agent-profiles-config.md, plans/003-per-agent-identity.md
- **Category**: migration
- **Planned at**: commit `e9216df`, 2026-09-09

## Why this matters

Die „Social Card" (Voice-Card, Kommunikationsstil-Profil) liegt heute in
EINER flat `social-learning-cache.json` mit einem globalen 256er-LRU und
einem `__global__`-Key, der bei `perSessionCard:false` ALLE Agenten und
Channels auf EINE Karte kollabiert. Konsequenz heute: Agent B's aktive
Sessions eviktieren Agent A's Karten; `perSessionCard:false` ist im
Multi-Tenant-Betrieb eine Cross-Contamination by design. Dieser Plan
namespacet Cache + Counter + Eviction pro agentId, versioniert das
State-Format (Migration gate), und macht damit „eigene Social Card pro
Agent und pro Channel" zuverlässig — E2E-verifiziert inkl.
Restart-Persistenz.

## Current state

Alle Zitate verifiziert bei `e9216df`. `lib/voice-card.js`:

```js
const GLOBAL_KEY = "__global__";                        // :11
const MAX_ENTRIES = 256;                                // :12
function evictOldest(obj, max = MAX_ENTRIES) {          // :14-19  insertion-order delete
  const keys = Object.keys(obj);
  while (keys.length > max) delete obj[keys.shift()];
}
export let cache = {};                                  // :31  sk|GLOBAL_KEY → card
export let counter = {};                                // :32  sk → n
export let refreshing = new Set();                      // :33
const lastRefreshTime = {};                             // :35

function cardKey(sessionKey, perSession) {              // :72-74
  return perSession ? sessionKey : GLOBAL_KEY;
}

function cacheFilePath() {                              // :79-81
  return path.join(stateDir, "social-learning-cache.json");
}
export function loadCache() {                           // :83-89  silent catch {}
  try {
    const data = JSON.parse(fs.readFileSync(cacheFilePath(), "utf8"));
    if (data.cache) Object.assign(cache, data.cache);
    if (data.counter) Object.assign(counter, data.counter);
  } catch {}
}
export function saveCache() { /* tmp+rename, {cache, counter} */ }   // :91-99

export function createVoiceCard({ cfg, engine, stateDir: sd, log }) {
  …
  setVoiceCardGetter((sk) => getCard(sk, cfg.socialLearning?.perSessionCard !== false));  // :110
```

Refresh-Pfad: `counter[sk]++` (:125), `cache[cardKey(...)] = promptBlock`
(:183), `evictOldest(cache)` + `evictOldest(lastRefreshTime)` (:185-186).
Getter-Signatur heute: `(sk) => card|null` (persona.js:32-34, konsumiert
in persona.js:45).

Disk-Befund (live, verifiziert): `state/social-learning-cache.json`
enthält `"__global__"` NEBEN sessionKeys mehrerer Agenten in EINEM
`cache`-Objekt — die Mischform existiert bereits in Produktion.

Konventionen: State-Dateien 0600/0700, tmp+rename, silent catch (AGENTS.md);
DAS bleibt — aber dieser Plan fügt als ERSTES State-File im Repo ein
`version`-Feld hinzu (Finding STATE-06: keine der State-JSONs hat eines).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Tests | `cd ~/human-engine && npm test` | all pass, 0 fail |
| Parity | `cd ~/human-engine && node test/parity-matrix.mjs --check` | `51/51 covered`, exit 0 |
| Unit | `cd ~/human-engine && node --test test/voice-card.test.js test/voice-card-local.test.js` | all pass |

## Scope

**In scope**:
- `~/human-engine/lib/voice-card.js`
- `~/human-engine/lib/persona.js` (nur Getter-Signatur: `(sk, agentId)`)
- `~/human-engine/test/voice-card.test.js`, `test/persona.test.js` (neue Cases)
- `~/human-engine/test/e2e-local.test.js` (E2E: Zwei-Agenten-Card-Isolation)
- `~/human-engine/test/parity-matrix.mjs` (eine neue Row, Step 6)

**Out of scope**:
- `lib/gate.js`, `lib/naturalize.js`, `lib/social-memory.js`, `index.js`
  (sind seit 003 per-agent aufgelöst; voice-card's onBeforePromptBuild
  bekommt cfg-pro-Auflösung selbst — siehe Step 3)
- Andere State-Files (proactive/dm-proactive → Plan 005)
- `openclaw.plugin.json` / lib/config.js — `socialLearning.perSessionCard`
  Schema bleibt; seine SEMANTIK ändert sich dokumentiert (Step 5)

## Git workflow

- Branch: `advisor/004-social-cards-per-agent`
- Commit pro Step; Stil `plan 004: …`. PUBLIC repo — keine echten
  Session-Keys/Karten in Fixtures.

## Steps

### Step 1: Disk-Format v2 mit Migration-on-load

Neues Format:
```json
{ "version": 2, "agents": { "<agentId>": { "cache": {}, "counter": {} } } }
```

- `loadCache()`: erst `version` prüfen.
  - `version === 2` → direkt laden.
  - Kein/`version === 1` (flat `{cache, counter}`) → MIGRIEREN: jeden
    Cache-Key `agent:<id>:…` nach `agents[id].cache` einsortieren (Key
    selbst unverändert — er bleibt der volle sessionKey); `__global__`
    → NICHT migrieren (veraltet, wird nicht mehr geschrieben — Hinweis
    per `log.warn` EINMAL); counter analog. Danach sofort `saveCache()`
    (einmaliger Format-Wechsel). Migration unter einem
    `migrateOnce`-Flag, damit ein kaputterload nicht loop-t.
  - Unlesbar → leere v2-Struktur (wie heute: silent catch).
- `saveCache()`: schreibt v2 (tmp+rename, 0600 — unverändert).
- In-Memory-Struktur: `cache`/`counter` werden zu
  `stateByAgent = new Map(); // agentId → { cache: {}, counter: {} }`;
  Exporte `cache`/`counter` gibt es nicht mehr öffentlich — ALLE
  internen Zugriffe über `bucketFor(agentId)` (lazy erzeugt,
  `__legacy__`-Bucket für agentId-los).
- Eviction: `evictOldest` je BUCKET (pro Agent 256 — identisches Limit,
  jetzt isoliert). `refreshing`/`lastRefreshTime` bleiben flach, aber
  keyed `agentId + "|" + sk` (Kollisionssicherheit).

**Verify**: Unit-Test: v1-File (fake `agent:test:…`-Key + `__global__`)
→ loadCache → Datei ist v2, sessionKey-Karte im Agent-Bucket, `__global__`
weg; zweites loadCache → idempotent.

### Step 2: cardKey pro Agent

```js
function cardKey(sessionKey, perSession, agentId) {
  return perSession ? sessionKey : ("__global__:" + agentId);
}
```
`perSessionCard:false` kollabiert jetzt nur noch INNERHALB eines Agenten
(dokumentierte Semantik-Änderung — Maintenance notes). Alle
cardKey-Aufrufstellen (:123, :183) mit agentId versorgen.

**Verify**: Unit-Test: zwei Agenten, perSessionCard:false → zwei
verschiedene Karten.

### Step 3: Handler + Getter pro Agent

1. `onBeforePromptBuild`: nach dem Scoping
   `const agentCfg = resolveAgentConfigForSession(cfg, sk, ctx?.agentId);`
   (Import config.js + scope.js). `perSession`-Ermittlung und cardKey
   gegen `agentCfg.socialLearning` statt `cfg.socialLearning`; agentId
   aus `parseScope(sk)?.agentId || ctx?.agentId`.
2. `setVoiceCardGetter((sk, agentId) => getCard(sk, perSession, agentId))`
   — Getter-Aufrufer in persona.js:45: `voiceCardGetter(sessionKey, agentId)`
   → persona.js braucht agentId: `buildPersonaPrompt(cfg, sessionKey,
   agentId)` mit optionalem dritten Param; alle Aufrufer (gate.js
   decide-Pfad, naturalize-Pfad — grep `buildPersonaPrompt(`) leiten
   `parseScope(sk)?.agentId` weiter (Plan 003 hat agentCfg dort bereits
   — nutze den vorhandenen agentId-Wert, NICHT doppelt parsen, wenn
   verfügbar).
3. `spawnRefresh` (Z. 156-192): agentId-Parameter; cache-Schreib/Zähler-
   Zugriffe über bucketFor(agentId).

**Verify**: `node --test test/voice-card.test.js test/persona.test.js` →
pass (neue Cases siehe Test plan).

### Step 4: E2E — Social-Card-Isolation + Restart-Persistenz

In `test/e2e-local.test.js` neuer describe „social card isolation":

1. Zwei Agenten (agent-a/agent-b, fake profile), gemeinsames stateDir
   (tmp-Dir via `HUMAN_ENGINE_STATE_DIR`-Äquivalent — voice-card nimmt
   stateDir per factory-Injection; nutze die Injection, NICHT die Env).
2. **Case A — getrennte Karten**: beide Session refreshen → prompt-build
   für agent-a injiziert NUR agent-a's Card-Text (fake engine liefert
   unterscheidbare prompt_blocks).
3. **Case B — Eviction-Isolation**: 260 Refreshes in agent-b → agent-a's
   Karte NOCH im Cache (eigener Bucket), agent-b's älteste evicted.
4. **Case C — Restart**: neue createVoiceCard-Instanz auf gleichem
   stateDir → beide Karten geladen (loadCache-v2).
5. **Case D — v1-Migration E2E**: v1-File vorlegen → Handler-Lauf →
   Karten beider Agenten injiziert, File v2.

**Verify**: `node --test test/e2e-local.test.js` → all pass.

### Step 5: Semantik-Doku

Repo-Wiki `wiki/operations/environment.md` (State-Files-Tabelle +
Config-Keys): `social-learning-cache.json` → Format v2, per-agent
Buckets, `perSessionCard:false` = eine Karte PRO AGENT (nicht mehr eine
für alle). AGENTS.md-Test-Zeile nur anfassen, wenn sich die Gesamtzahl
strukturell ändert.

**Verify**: `grep -n "version.*2\|per agent" wiki/operations/environment.md` → Treffer.

### Step 6: Parity-Row

Neue Row nach id 51 (sequenzielle Konvention, Muster: Plan-587-Row 51):
```js
{ id: 52, behavior: "social cards are isolated per agent: per-agent cache buckets, per-agent eviction, perSessionCard:false collapses per agent only (v1 cache migrates on load)",
  tags: ["social card isolation"] },
```
Tags müssen Substring der neuen Testnamen sein (Stil Plan 586 Step 4).

**Verify**: `npm test` → all pass; `node test/parity-matrix.mjs --check` →
`52/52 covered`, exit 0.

## Test plan

- Unit (voice-card.test.js): v2 round-trip; v1-Migration (inkl.
  `__global__`-Verwurf + warn-once); per-agent cardKey; Eviction pro
  Bucket; counter/lastRefreshTime-Collision-Sicherheit.
- Unit (persona.test.js): Getter-Signatur (sk, agentId); Agent ohne
  Karte → null; aufruf-Weiterleitung agentId.
- E2E (e2e-local.test.js): die 4 Cases aus Step 4.
- Verification: `npm test` all pass; Parity 52/52.

## Done criteria

- [ ] `state/social-learning-cache.json` wird als v2 mit per-agent Buckets geschrieben; v1-Files migrieren on-load (Test belegt)
- [ ] `perSessionCard:false` liefert pro Agent EIGENE Karte (Test belegt)
- [ ] E2E social-card-isolation grün (4 Cases)
- [ ] `npm test` exit 0; Parity `52/52 covered`
- [ ] `git status` nur In-Scope-Dateien
- [ ] `plans/README.md` Status-Row aktualisiert

## STOP conditions

- Drift: Ausschnitte passen nicht (oder 002/003 nicht im HEAD).
- Migration-Test verliert nachweislich Karten (v1-Key ohne
  `agent:`-Präfix außer `__global__` auftaucht — Semantik unklar) →
  stoppen, Key-Beispiele melden. NICHT raten.
- Gate/naturalize-Aufrufer können agentId für buildPersonaPrompt nicht
  liefern, ohne Verhalten zu ändern → melden (Schnittstellenfrage).
- Parity kann nicht auf 52 wachsen ohne bestehende Row anzufassen → melden.

## Maintenance notes

- Erster `version`-Field-Use im Repo — Folge-Pläne (005 für
  proactive/dm-proactive-State) übernehmen das Muster.
- `__global__`-Karten aus v1 gehen bewusst verloren (cross-tenant
  kontaminiert; Neulernen kostet 1 LLM-Call nach 5 Messages). Im
  Deploy-Note an Kevin erwähnen.
- Reviewer-Schwerpunkt: Migration-Pfad (idempotent, einmalig),
  Getter-Signatur-Änderung an ALLEN Aufrufstellen, Eviction-Grenzen.
