# Plan 017: DM-Proactive-Budget per Agent — flat Cross-Agent-Map auf Plan-005-Tenancy umstellen

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git -C ~/human-engine diff --stat c4e148b..HEAD -- lib/dm-proactive.js test/dm-proactive.test.js`
> On mismatch with the "Current state" excerpts: STOP condition.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: MED (State-Shape v3 → v4 mit Migration; Fehlschärfe =
  Budget-Zähler falsch → falsche Sendefrequenz)
- **Depends on**: none (Plan 014 optional vorher — parseAgentScope-Konsolidierung berührt dieselbe Datei; Merge-Konflikt-vermeidend NACH 014 ausführen)
- **Category**: bug / migration
- **Planned at**: commit `c4e148b`, 2026-09-09

## Why this matters

Plan 005 machte `sentIds`/`byKind` per-Agent (sentBuckets-Pattern), aber das
`budget` blieb eine FLATTE Map `{ [scope]: { day, count, careCount, … } }`
über ALLE Agenten hinweg, gecappt bei 256 Einträgen über ALLE Scopes
(dm-proactive.js:87, :444 capObject). Mit >256 aktiven DM-Scopes über
mehrere Agenten kann ein aktiver Scope von fremdem Traffic evicted werden →
getBudget liefert einen frischen Zähler → Budget „ resettet" → mögliche
zusätzliche/care-Followups. Das widerspricht dem Tenancy-Vertrag der
Schwester-Maps.

## Current state

`lib/dm-proactive.js` (bei `c4e148b`):

```js
// ~Z. 87
const budget = {};
const BUDGET_FLUSH_MS = 2000;
const SENT_IDS_MAX = 512;
// ~Z. 444 (capObject über die FLATTE budget-Map)
capObject(budget, MAX_ENTRIES);   // MAX_ENTRIES = 256
```

Das Modul PERSISTIERT Budget in `state/dm-proactive-state.json` (Version 3,
Shape `{ version: 3, agents: { <agentId>: { sentIds, byKind } } }` plus
`__legacy__`-Bucket). WIE budget genau persistiert wird (im selben File?
separater Abschnitt?), musst du beim Öffnen der Datei verifizieren — suche
`budgetDirty`, `budgetTimer`, `flushBudget`/`saveBudget`, `loadBudget` und
die v3-load-Funktion. STOP, wenn budget NICHT in derselben State-Datei
persistiert wird oder die Form fundamental anders aussieht als in diesem
Plan angenommen.

Ziel-Shape (analog sentBuckets, Plan 005):

```js
const budgetBuckets = new Map(); // agentId → { [scope]: entry } — pro Agent cap 256
```

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Unit | `node --test test/dm-proactive.test.js` | all pass |
| Tests | `npm test` | all pass, 0 fail |
| Parity | `node test/parity-matrix.mjs --check` | fully covered, exit 0 |

## Scope

**In scope**:
- `lib/dm-proactive.js` (budget-Buckets + Persistenz-Migration v3→v4)
- `test/dm-proactive.test.js` (Tenancy-Cases + Migration)
- `test/dm-proactive-fixtures.js` (falls State-Fixtures die Form verankern)

**Out of scope**:
- `lib/dm-gate-core.js` (Regeln unverändert)
- `bin/followup-gate.mjs` (CLI liest denselben State NUR read-only über die
  Load-Funktion — Form-Änderung muss die CLI-Load mitnehmen! Prüfen: wenn
  die CLI die State-Datei selbst parst (grep budget), MUSS sie mitmigriert
  werden → dann IN scope; sonst out)
- sentIds/byKind-Logik

## Git workflow

- Branch: `advisor/017-dm-budget-tenancy`
- 1–2 Commits; Stil `plan 017: …`

## Steps

### Step 1: Persistenz-Form verifizieren

Lies `lib/dm-proactive.js` komplett (Load/Save/Flush des Budgets) und
`bin/followup-gate.mjs` (grep nach budget-Reads). Kläre: (a) In welcher
Datei/Struktur lebt budget? (b) Liest die CLI budget? Wenn (a) oder (b)
vom Plan abweicht → STOP-Bedingung prüfen (siehe unten).

**Verify**: Notiz im Commit-Body über die verifizierte Form.

### Step 2: budgetBuckets einführen

1. `const budget = {}` → `const budgetByAgent = new Map()` mit
   `bucketFor(agentId)`-Helper (Muster: voice-card.js `bucketFor`, oder das
   eigene sentBuckets des Moduls — NACH dem lokalen Muster).
2. `getBudget`/`bumpBudget` (und alle `budget[scope]`-Zugriffe) über
   `bucketFor(agentIdFromScope(scope))[scope]` führen.
3. capObject pro Bucket mit 256 (NICHT global).
4. `deriveDmFromEvent` iteriert heute `Object.keys(budget)` über ALLE
   Scopes, um DM-Scope-Owner zu finden (Z. ~570er Block) — muss über alle
   Buckets aller Agents iterieren (Verhalten: gleiche Owner-Resolution).
5. Persistenz: v3-Load erkennt flat budget-Scopes → migriert in
   per-Agent-Buckets (Scope enthält `::` → agentId ableitbar); v4 schreiben
   (`version: 4` mit `agents: { <agentId>: { sentIds, byKind, budget } }`).
   Unbekannte Version → bestehende v3-Fallback-Logik erweitern (nie werfen).
6. Flush/Timer/Dirty-Flag pro Bucket bzw. global lassen (ein Timer für
   alle Buckets ist okay — nur die CAPs sind pro Agent).

**Verify**: `node --test test/dm-proactive.test.js` → pass (Fixtures evtl.
an v4 anzupassen — Anpassung ist erlaubt, wenn sie die SEMANTIK verankert,
nicht nur die Form).

### Step 3: Tests

1. Zwei Agenten, je >256 Scopes bumpen → Agent-A-Scopes überleben, Agent-B
   evicted (bisher: global evicted quer).
2. Budget-Reset-Bug-Anker: Agent A füllt 260 Scopes, Agent B hat 1 aktiven
   Scope → B's budget-Eintrag bleibt erhalten (count bleibt).
3. Migration: v3-Fixture (flat budget-Sektion falls vorhanden, sonst
   v3 ohne budget) → load → per-Agent-Buckets; `__legacy__`-Konvention für
   Scopes ohne parsebaren AgentId.
4. deriveDmFromEvent: mit Einträgen in zwei Agent-Buckets → Owner-Resolution
   unverändert (bestehende Cases decken das — prüfen, ggf. ein Case mit
   zweitem Agenten ergänzen).
5. Parity-Row am Ende: „dm-proactive budget is per-agent namespaced with
   per-agent eviction (Plan 005 parity for budget)".

**Verify**: `npm test` → all pass; Parity fully covered.

## Test plan

Siehe Step 3. Muster: die Plan-005-Tenancy-Tests in test/dm-proactive.test.js
(grep sentBuckets/„per-agent").

## Done criteria

- [ ] `rg -n "const budget = \{\}" lib/dm-proactive.js` → kein Treffer
- [ ] `rg -n "budgetByAgent|bucketFor" lib/dm-proactive.js` → Treffer
- [ ] `npm test` exit 0 inkl. neuer Cases; Parity fully covered
- [ ] `plans/README.md` Status-Row aktualisiert

## STOP conditions

- Budget ist NICHT in `state/dm-proactive-state.json` persistiert oder die
  Lade-Form widerspricht diesem Plan fundamental → STOP mit Form-Beschreibung.
- Die CLI `bin/followup-gate.mjs` parst budget selbst und kann nicht ohne
  Verhaltensänderung migriert werden → STOP (dann muss die Load-Funktion
  geteilt werden — Design-Entscheidung, nicht Executor-Improvisation).
- Ein bestehender Plan-536/546-Incident-Test (duplicate cancel, envelope
  safety) bricht inhaltlich → STOP.

## Maintenance notes

- Nach Landung haben alle drei DM-Proactive-State-Slices Tenancy:
  sentIds, byKind, budget — der Plan-004/005-Vertrag ist vollständig.
- Rollout: version 4-Datei wird von älterem Code (Rollback-Szenario) nicht
  gelesen → Rollback-Handgriff: Backup der State-Datei vor Deploy
  (Live-Checkliste Plan 006, Operator-Schritt).
