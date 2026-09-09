# Plan 005: Proactive/DM-Proactive-State pro Agent namespacen + `dmProactive.agents` (Plan-586-Adoption) + DayFit-Pfad-Config

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git -C ~/human-engine diff --stat e9216df..HEAD -- lib/proactive.js lib/dm-proactive.js lib/dayfit.js bin/followup-gate.mjs index.js test/`
> On mismatch with the "Current state" excerpts (beyond 001–004's own
> changes): STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED (DM-Followup-Lane ist live; Fehlverhalten = Incident-Klasse 536/546: rohe Envelope an Kevin oder verweigerte Followups. Shadow-Fenster nicht zurücksetzen.)
- **Depends on**: plans/001-canonical-scope-parser.md, plans/002-agent-profiles-config.md, plans/003-per-agent-identity.md
- **Category**: migration
- **Planned at**: commit `e9216df`, 2026-09-09

## Why this matters

Drei verbleibende Cross-Tenant-Kopplungen im Proactive-Stack: (1)
DM-proactive `byKind`-Cadence ist nur per KIND keyed — Agent A's
Ignore-Streak pausiert Agent B's Soft-Followups (dm-proactive.js:105-117,
verifiziert); (2) `sentIds` ist EIN globaler 512er-LRU — ein Agent kann
dem anderen legitime Kandidaten als „duplicate" nehmen (:99-100); (3)
DayFit liest hardcoded die EINE `kevin-activity.json` (dayfit.js:24-29).
Zusätzlich adoptiert dieser Plan die fertige Blaupause Plan 586
(`dmProactive.agents`-Override + `isScopedDmAgent` — SUPERSEDED, nie
executed, Steps 1–3 von dort sind reviewed-Qualität) und schließt den
Fresh-State-Fallback für ≥2 Agenten. Alles E2E-getestet, Shadow-Fenster
unberührt.

## Current state

Alle Zitate bei `e9216df` selbst gelesen.

`lib/dm-proactive.js`:
- :61-63 `scopeKey(agentId, sk) { return (agentId || "?") + "::" + sk; }` — Budgets sind PRO SCOPE (ok).
- :92 `const budget = {};` (scope → {day, count, careCount, …}) — ok.
- :94-100:
  ```js
  const SENT_IDS_MAX = 512;
  const sentIds = [];          // EIN globaler LRU
  const sentIdSet = new Set();
  ```
- :105-117 `const byKind = {};` + `byKindKey(kind)` — keyed NUR per kind:
  ```js
  function byKindKey(kind) { return String(kind || "soft_followup").toLowerCase(); }
  function ensureByKind(kind) { const k = byKindKey(kind); if (!byKind[k]) byKind[k] = { budgetMultiplier: 1.0, sends: [], replyRate14d: 0.0, ignoreStreak: 0, paused: false }; return byKind[k]; }
  ```
- :119-152 `loadBudget()` (liest `{scopes, sentIds, byKind}` — v2-Format, KEIN version-Feld); :154-163 `saveBudget()` schreibt `{ scopes: budget, sentIds, byKind }`.
- :421-466 `onMessageReceived` (Reply-Attribution schreibt in kind-globales byKind).
- :427/:567 `if (!isScopedAgent(cfg, agentId)) return;` (global allowlist).
- :493-531 `deriveDmFromEvent` — Fallback (b) :524-527:
  ```js
  const agents = Array.isArray(cfg?.agents) ? cfg.agents : [];
  if (uniqueOwners.length === 0 && agents.length === 1) {
    return { sk: `agent:${agents[0]}:${channel}:direct:${uid}`, agentId: agents[0] };
  }
  ```
  → bei ≥2 konfigurierten Agenten failt fresh-state-Ableitung still (fail-open, nicht routbar).
- :86-87 `stateFile`/`logFile` global (ein File je Modul).

`lib/proactive.js`:
- :73-75 `scopeFor` per `agentId::sessionKey` (ok); :178 `stateFile = …/proactive.json`; :186-188 `counters/cooldowns/engagements` scope-keyed; :257/:336/:618 `capObject(…, 256)` GLOBAL — Agent B evictet Agent A's Cooldowns.

`lib/dayfit.js`:
- :24-29 `DEFAULT_ACTIVITY_PATH = path.join(HOME, ".openclaw", "state", "kevin-activity.json")`; :45-52 `dayFitFactor({ now, filePath = DEFAULT_ACTIVITY_PATH, reduceHours, pauseHours, cache, log })` — filePath-Param EXISTIERT; `index.js:72` `createDmProactive({ cfg, llm, socialMemory, runtime, stateDir, log })` übergibt `activityFilePath` NICHT.

`bin/followup-gate.mjs` (Blueprint-Plan 586 Zitat + Subagent-Befund konsistent): lädt resolveConfig, scope = `agentId::sessionKey` via `--agent`/`--session`, liest DEN globalen sentIds-Pool, `newestSpeaker: null` + globaler agentName (:121).

Live-Kontext (NICHT anfassen, nur wissen): Followup-Cron `b720fddc`,
Agent `hori-wa`, `*/45`, Shadow-Fenster läuft (Q4-Kriterium, Neustart
2026-09-04). `state/dm-proactive-state.json` = v2-Format on disk.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Tests | `cd ~/human-engine && npm test` | all pass, 0 fail |
| Parity | `cd ~/human-engine && node test/parity-matrix.mjs --check` | `51/51` (+ neue Rows, exit 0) |
| Unit | `cd ~/human-engine && node --test test/dm-proactive.test.js test/proactive.test.js` | all pass |
| CLI-Smoke | `cd ~/human-engine && node bin/followup-gate.mjs 2>&1 | head -2` | usage/exit 3 (ungenügende Args) |

## Scope

**In scope**:
- `~/human-engine/lib/config.js` (dmProactive.agents + isScopedDmAgent + dayFitActivityPath-Key)
- `~/human-engine/openclaw.plugin.json` (Schema-Keys)
- `~/human-engine/lib/dm-proactive.js` (sentIds/byKind pro Agent, v3-Format + Migration, isScopedDmAgent, Fallback (b), dayfit-Pfad-Pro-Agent)
- `~/human-engine/lib/proactive.js` (per-agent Buckets für counters/cooldowns/engagements + version)
- `~/human-engine/lib/dayfit.js` (nur Default-Pfad-Injektion von außen — Logik unverändert)
- `~/human-engine/index.js` (createDmProactive: activityFilePath aus cfg)
- `~/human-engine/bin/followup-gate.mjs` (isScopedDmAgent + pro-agent sentIds-Lesung)
- `~/human-engine/test/dm-proactive.test.js`, `test/proactive.test.js`, `test/config.test.js`, `test/e2e-local.test.js`, `test/parity-matrix.mjs`

**Out of scope**:
- `lib/dm-gate-core.js` (Regel-Engine bleibt ctx-getrieben — Regeln ändern sich NICHT, nur ihre ctx-Befüllung)
- `state/dm-proactive.jsonl` (Log-Format bleibt; hat scope/agentId bereits)
- Live-Config + Cron `b720fddc` (Operator-Schritt NACH dem Merge — Maintenance notes)
- `lib/mood.js`, `lib/voice-card.js`, `lib/gate.js`, `lib/naturalize.js`

## Git workflow

- Branch: `advisor/005-proactive-tenancy`
- Commit pro Step; Stil `plan 005: …`. PUBLIC repo — UIDs (wie die im
  Incident-2-Test genannte Telegram-UID) nur im bestehenden Test-Format
  verwenden, sonst fake UIDs (`999999999`-Form).

## Steps

### Step 1: `dmProactive.agents` + `isScopedDmAgent` + `dayFitActivityPath` in config.js + Schema

EXAKT Plan 586 Step 1 + Step 2 übernehmen (Datei
`~/plans/586-human-engine-hori-wa-unscope-dmproactive-agents.md` im
WORKSPACE, nicht im Repo — Zitat in Current state von 586 ist
verbindlich): `dmProactive.agents: []` Default, `dmProactiveAgents(cfg)`
(Override gewinnt, sonst Global-Liste), `isScopedDmAgent(cfg, agentId)`;
Schema-Key in `dmProactive.properties`. ZUSÄTZLICH (über 586 hinaus):
`dmProactive.dayFitActivityPath: ""` (string, Default "") in
defaultConfig + Schema; `resolveAgentConfig` behandelt es automatisch
(scalares Profile-Override).

**Verify**: 586-Step-1-Verify-Kommando (`dmProactiveAgents`/`isScopedDmAgent`
Smoke) → `[] [ 'a' ] true false`; `node --test test/config.test.js` → pass.

### Step 2: dm-proactive.js — isScopedDmAgent + Fallback (b) + dayfit-Pfad

1. Import: `isScopedDmAgent, dmProactiveAgents` statt `isScopedAgent`
   (genau 3 Call-Sites: :427, :524-527, :567 — 586 Step 3).
2. Fallback (b): `const agents = dmProactiveAgents(cfg);` — bei ≥2
   Agenten bleibt fail-open (Absicht: Mehrdeutigkeit wird NIEMALS
   geraten; die frische Lane wird über Profile/Derive in Plan-006-Runbook
   seeded). Kommentar aktualisieren.
3. DayFit: `createDmProactive` erhält `activityFilePath` bereits (:81
   Param existiert!). Änderung: pro Kandidat
   `resolveAgentConfig(cfg, agentId).dmProactive?.dayFitActivityPath ||
   dcfg.dayFitActivityPath || null` → als filePath an `dayFitFactor`
   statt des pauschalen `_activityFilePath`. `index.js:72` ergänzen:
   `activityFilePath: cfg.dmProactive?.dayFitActivityPath || null`.
4. `agentName`-ctx an `evaluateDmGate`: bereits per-agent seit Plan 003.

**Verify**: `grep -n "isScopedAgent" lib/dm-proactive.js` → 0 Treffer;
`node --test test/dm-proactive.test.js` → pass; neue 586-Regression-Tests
(Step 4) noch offen.

### Step 3: sentIds + byKind pro Agent (State v3 + Migration)

1. Format v3: `{ version: 3, scopes: {}, sentIds: { "<agentId>": [ … ] }, byKind: { "<agentId>": { "<kind>": {…} } } }` (je Agent eigener 512er-LRU).
2. Migration-on-load (Muster Plan 004, version-gated):
   - v2/kein version: flat `sentIds` → Bucket `"__legacy__"`; flat
     `byKind` → `"__legacy__"`-Bucket. `scopes` unverändert übernehmen.
   - Gate-Lesung (`hasSentId`, `resolveByKind`, Reply-Attribution,
     bumpBudget): Agent-Bucket ERST, dann `__legacy__`-Bucket
     (Legacy-Dedup bleibt wirksam); Schreibungen NUR in den
     Agent-Bucket. Legacy veraltet damit natürlich (kein Rückschreiben).
   - Sofort-save nach Migration, `migrateOnce`-Guard.
3. Alle Zugriffe über `sentBucketFor(agentId)` / `byKindBucketFor(agentId)`
   (lazy). `ensureByKind(kind, agentId)`, `byKindKey` bleibt.
4. `saveBudget`/`loadBudget` auf v3 umstellen.

**Verify**: Unit-Tests: v2-File (fake) → v3 migriert; sentId in
agent-a-Bucket blockt agent-b NICHT (aber agent-a selbst); ignoreStreak
von agent-a pausiert agent-b's kind nicht; `__legacy__`-Eintrag blockt
beide (Dedup-Sicherheit beim Übergang).

### Step 4: proactive.js — per-agent Buckets + version

`counters/cooldowns/engagements`: gleiche Umbau-Methode wie Step 3 —
`{ version: 2, agents: { "<agentId>": { counters, cooldowns, engagements } } }`
(Migration: v1 flat scope-keys `"<agentId>::<sessionKey>"` per
Split-at-`::`-ersten Segments einsortieren; Keys ohne `::` →
`__legacy__`). `capObject` je Bucket (pro Agent 256). scopeFor/evaluate-
Logik unverändert.

**Verify**: Unit: v1-File migriert; Eviction in agent-b-Bucket löscht
agent-a's Cooldown nicht.

### Step 5: followup-gate.mjs — Agent-Bewusstsein

1. `isScopedDmAgent` anwenden (exit 0 mit `reason: "agent-not-scoped"`
   statt Stillstand — Doku-Kommentar anpassen; KEIN raw-Envelope-Pfad,
   der CLI entscheidet nur pre-send).
2. sentIds-Lesung: Agent-Bucket (+legacy) statt globalem Pool.
3. agentName: `resolveAgentConfig(cfg, agentId).agentName || "Agent"`.

**Verify**: CLI-Smoke beider Varianten (`--agent` scoping-positiv/negativ)
mit Fake-State-File (`--state`-Param falls vorhanden — Datei lesen und
eigentlich vorhandene Flags nutzen; KEINE neuen CLI-Flags erfinden:
wenn der CLI-State-File-Pfad nicht injizierbar ist, Test über
`HUMAN_ENGINE_STATE_DIR`).

### Step 6: E2E — Zwei-Agenten-Followup-Isolation (DER Zuverlässigkeitsanker)

In `test/e2e-local.test.js` neuer describe „proactive tenancy" (Muster:
bestehende naturalize-e2e + `test/helpers/dm-proactive-fixtures.js`):

1. **Case A — sentIds-Isolation**: gleicher Envelope-`id` von agent-a
   erfolgreich; identischer id von agent-b → KEIN duplicate-cancel
   (verschiedene Buckets).
2. **Case B — byKind-Isolation**: agent-a ignoreStreak 4 (paused) →
   agent-b's soft_followup läuft auf vollem Budget.
3. **Case C — Fallback (b)**: frischer State, `dmProactive.agents:
   ["agent-b"]`, Global-Liste zwei Agenten → Derive löst agent-b auf
   (586-Regression).
4. **Case D — Legacy-Dedup**: v2-State mit sentId X migriert → X von
   JEDEM Agent weiterhin blockiert (einmalige Zustellung über den
   Übergang).
5. **Case E — Envelope-Sicherheit**: während aller Cases verlässt NIEMALS
   ein `[[fu:`-Präfix raw den Hook (Assertion über dispatcher/subagent-fake —
   Incident-Klasse 536/546 ist Vertrag).

**Verify**: `node --test test/e2e-local.test.js` → all pass.

### Step 7: Parity-Rows + Doku

1. Neue Rows (sequenziell ab 53, Muster Plan 586/587):
   - `{ id: 53, behavior: "dm-proactive tenancy: dmProactive.agents overrides global agents (DM lane stays gated while global features unscope the agent)", tags: ["dm-proactive tenancy"] }`
   - `{ id: 54, behavior: "proactive/dm-proactive state isolated per agent: per-agent sentIds and byKind buckets (legacy v2 migrates), per-agent proactive budgets/eviction", tags: ["proactive tenancy"] }`
   (Tags = Substring der Testnamen aus Step 6 + 586-Tests.)
2. Wiki `wiki/operations/environment.md`: State-Formate v3/v2, neue
   Config-Keys, Bucket-Modell.

**Verify**: `npm test` → all pass; `node test/parity-matrix.mjs --check`
→ `54/54 covered`, exit 0.

## Test plan

- Unit: config (586-Step-4-Set + dayFitActivityPath-Merge);
  dm-proactive (v3-Migration, Bucket-Isolation, Fallback b, kind-iso);
  proactive (v2-Migration, per-agent cap).
- E2E: 5 Cases (Step 6).
- CLI: Step 5-Smokes.
- Verification: `npm test` all pass; Parity 54/54.

## Done criteria

- [ ] `grep -n "isScopedAgent" lib/dm-proactive.js bin/followup-gate.mjs` → 0 Treffer
- [ ] State-Files werden mit `version` geschrieben; v1/v2 migrieren on-load (Tests belegen)
- [ ] E2E proactive-tenancy grün (5 Cases, inkl. Envelope-Sicherheit)
- [ ] `npm test` exit 0; Parity `54/54 covered`
- [ ] `git status` nur In-Scope-Dateien
- [ ] `plans/README.md` Status-Row aktualisiert

## STOP conditions

- Drift in den Zitaten (insb. dm-proactive.js :427/:524/:567/:99-117).
- Shadow-Fenster-Metrik (`state/dm-proactive.jsonl`) würde durch das
  Refactor-Verhalten invalidiert (z. B. Log-Einträge fehlen nach Tests
  mit Live-Dir) → NIE mit Live-State testen; Tests MUSSEN tmp-stateDir
  nutzen. Falls doch passiert: stoppen, melden.
- Der v2→v3-Migrationspfad erfordert Raten bei der Agent-Zuordnung →
  stoppen (Entscheidung: `__legacy__`-Bucket ist die Dokument-Entscheidung;
  wenn die im Code nicht abbildbar ist, melden).
- Parity-Rows brechen inhaltlich (nicht nur Neunummerierung) → melden.

## Maintenance notes

- **Deploy-Order (aus Plan 586 gelernt)**: Code MERGEN + Gateway-Restart
  VOR jeder Config-Änderung (`dmProactive.agents` setzen etc.). Erst nach
  stabilem Betrieb die Live-Config umstellen (Operator + Kevin-Review;
  586 Step 5/6 als Checkliste).
- Shadow-Fenster/Q4: KEIN Reset nötig — Log-Format unverändert; nur
  State-File migriert (scopes bleiben identisch).
- Legacy-Buckets sterben natürlich; nach 30 Tagen Betrieb können sie aus
  der Leselogik entfernt werden (kleiner Folge-Commit).
- DayFit bleibt single-TZ Berlin (Finding ARCH-13) — bewusst, hori-wa
  ist Berlin; per-agent TZ wäre Folgewerk über Profiles.
- Reviewer-Schwerpunkt: (a) Envelope-Sicherheit unverändert (Amendment 3),
  (b) Migration idempotent, (c) CLI-Exit-Codes 0/1/2/3 unverändert.
