# Plan 019: Cross-Session Personen-Identität — Memory pro MENSCH statt pro Session speichern

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git -C ~/human-engine diff --stat c4e148b..HEAD -- lib/social-memory.js lib/gate.js lib/config.js openclaw.plugin.json test/social-memory.test.js`
> On mismatch with den "Current state" excerpts: STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED (Storage-Umstellung + Migration; Write-Amplifikation pro Agent ist bewusst akzeptiert; Namens-Kollisionen = dokumentierte Grenze)
- **Depends on**: 011 (Ingest-Kadenz — sonst zählt die Migration verdreifachte Hooks)
- **Category**: direction / migration
- **Planned at**: commit `c4e148b`, 2026-09-09

## Why this matters

Heute ist der Memory-Scope `agentId::sessionKey`: derselbe Mensch (Kevin)
hat getrennte Profile in der Klettergruppe, in der zweiten Gruppe und in
DMs — der Agent kennt ihn intim im einen Raum und grüßt ihn im anderen als
Fremden. Das ist der größte Blocker für das Owner-Ziel „Social Memory zu
Personen". Der Fix: Profile pro AGENT in einer gemeinsamen
people-Map speichern, keyed nach dem aufgelösten Kontakt-Namen. Die
Namens-Auflösung passiert bereits im Gate (resolveSender via contacts.md);
Personen ohne Kontakt-Auflösung bleiben über stabile `member-XXXX`-Keys
pro Agent identifiziert (gleiche lid → gleicher Fallback-Name in allen
Sessions desselben Agents, da resolveSender denselben Algorithmus nutzt).

## Current state

`lib/social-memory.js` (bei `c4e148b`) — relevante Mechanik:

```js
// Z. 15-18: Datei pro SESSION
function scopeToPath(stateDir, agentId, sessionKey) {
  const base = path.join(stateDir, "social-memory", pathSafe(agentId));
  return { dir: base, file: path.join(base, pathSafe(sessionKey) + ".json") };
}
// Z. 35-39: parseScope(scope) → { agentId, sessionKey } via lastIndexOf("::")
// Z. 77-95: getOrLoadProfile(scope) — Cache + Load + Normalisierung pro scope
// Z. 103-150: writeProfile → dirtyScopes + 2-s-Flush-Timer → writeProfileFile
// Z. 156-189: ingest(scope, {...}) — Buffer pro scope, metadata pro Person
// Z. 191-277: extract(scope) — buildMemoryExtractPrompt v1, Merge in existingProfile.people
// Z. 279-333: recall(scope, involvedNames) — involved + top-3 nach lastSeenTs, 800-Char-Cut
```

gate.js: `ingestSocial` (Z. 121-125) ruft
`socialMemory.ingest(agentId + "::" + sk, { speaker, … })`;
`markSpeak` (Z. 142-149) ruft `recall(scope, [senderName, agentName])` und
speichert in `state.memoryBySession`. `speaker` ist der via contacts
aufgelöste Name (gate resolveSender, Z. 45-58; Fallback `member-XXXX`).

dm-proactive.js:748-771: `memoryReferenceFor` nutzt
`socialMemory.getOrLoadProfile(scope)` mit Session-Scope.

Live-Kontext: `hori-wa` (DMs) hat aktuell KEINEN agentProfiles-Eintrag mit
contactsPath → DM-Sender fallen auf `member-XXXX` zurück. Damit Cross-Session
-Namen zusammenlaufen, ist der OPERATOR-Schritt nötig (siehe Maintenance),
der Plan selbst funktioniert auch ohne (member-Keys sind stabil).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Unit | `node --test test/social-memory.test.js` | all pass |
| Tests | `npm test` | all pass, 0 fail |
| Parity | `node test/parity-matrix.mjs --check` | fully covered, exit 0 |

## Scope

**In scope**:
- `lib/social-memory.js` (Storage-Layer: scopeToPath, getOrLoadProfile,
  Migration, Dirty/Flush keyed by agentId; Buffer bleibt per Session)
- `lib/config.js` + `openclaw.plugin.json` (neue Option
  `socialMemory.personStore`, default false)
- `test/social-memory.test.js` (Migration + Tenancy + Person-Growth)
- `test/parity-matrix.mjs` (neue Rows am Ende)

**Out of scope**:
- `lib/gate.js` (Signatur von ingest/recall bleibt → keine Änderung nötig)
- `lib/dm-proactive.js` (memoryReferenceFor funktioniert über die
  unveränderte getOrLoadProfile-Signatur)
- Recall-Qualität/v2-Rendering (Plan 020/021)
- Die contacts.md-Pflege der Agents (Operator-Schritt)

## Git workflow

- Branch: `advisor/019-person-store`
- 3–4 Commits (Config+Switch, Storage+Migration, Tests); Stil `plan 019: …`

## Steps

### Step 1: Config-Flag

`lib/config.js` defaultConfig().socialMemory um `personStore: false`
ergänzen; `openclaw.plugin.json`-Schema um die Boolean-Property ergänzen
(strict schema — KEINE additionalProperties-Lücke).

**Verify**: `node --test test/config.test.js` → pass.

### Step 2: Storage-Layer umstellen (hinter personStore:true)

1. Neue Pfad-Funktion:
   ```js
   function agentProfilePath(stateDir, agentId) {
     return path.join(stateDir, "social-memory", pathSafe(agentId) + ".json");
   }
   ```
2. Internen Profil-Zugriff umleiten: `profileCacheFor(scope)` — bei
   `personStore:true` cache-keyed nach agentId (aus parseScope), geladen
   von agentProfilePath; bei false exakt das heutige Verhalten
   (Session-Datei). Alle internen Nutzer (getOrLoadProfile, ingest,
   extract, recall, writeProfileFile) laufen über DIESE eine Indirektion —
   keine Einzelfall-Branches.
3. writeProfileFile schreibt bei personStore:true die Agent-Datei
   (dirty-scopes → agent-keyed dirty + ein Flush-Timer pro Agent).
   Das 64-KB-Oversize-Eviction (Z. 136-143) greift unverändert.
4. Buffer (`bufferByScope`), `newSinceExtract`, `lastExtractTs`,
   `inflightExtract` bleiben PER SESSION (Extraktion ist
   Session-Kontext-Arbeit, die in die Personen-Map merged).
5. Zwei parallele Extracts verschiedener Sessions desselben Agents mutieren
   das gemeinsame Profil-Objekt — der bestehende livePeople-Re-Apply
   (Z. 258-268) deckt Metadata; Fakt-Merge ist „parsed.people gewinnt" pro
   Person. Als bekannte Einschränkung dokumentieren (MED-Risk-Note im Code).

**Verify**: `node --test test/social-memory.test.js` → pass (Bestehendes
läuft mit default false unverändert).

### Step 3: Migration (einmalig pro Agent)

Beim ersten Profil-Zugriff eines Agents unter personStore:true:

1. Alle `*.json` im Agent-Ordner (state/social-memory/<agentId>/) außer
   der neuen <agentId>.json lesen; jede Session-Datei liefert people-Maps.
2. Merge je Person: facts/preferences = Union per String-Gleichheit (Cap
   beibehalten: slice(0,20)), situation = längere nicht-leere,
   lastSeenTs = max, mentionCount = sum.
3. Ergebnis in die Agent-Datei schreiben; Session-Dateien nach
   `state/social-memory/<agentId>/legacy-sessions/` VERSCHIEBEN (nicht
   löschen; PII bleibt 0600 — dir mit mode 0o700 anlegen).
4. Migration mit einem Marker in der Agent-Datei verdrahten:
   `{ version: 1, migrated: true, people: { … } }` — erneutes Migrieren
   wird am Marker erkannt (Datei-Existenz reicht: ist <agentId>.json da UND
   legacy-sessions existiert oder people vorhanden → gilt als migriert;
   STOP-frei, idempotent).
5. Profile-Cache mit Agent-Key befüllen.

**Verify**: `node --test test/social-memory.test.js` → Migration-Case grün.

### Step 4: Tests

1. Migration: 3 Session-Dateien (2× „Kevin" mit verschiedenen facts, 1×
   „Tobi") unter einem Agent → Agent-Datei hat Kevin mit Union + Tobi;
   Session-Dateien im legacy-Ordner; zweite Init → keine Doppel-Migration.
2. Cross-Session-Growth: ingest Session A („Kevin"), ingest Session B
   („Kevin") → EIN Profil wächst (mentionCount 2, lastSeenTs max).
3. Agent-Isolation: „Kevin" in Agent 1 ≠ „Kevin" in Agent 2 (getrennte
   Dateien) — Tenancy-Anker.
4. personStore:false → exakt heutiges Verhalten (Session-Dateien, keine
   Agent-Datei) — bestehende Tests grün ohne Anpassung.
5. recall: involved-Name findet die Person auch bei ingest über eine
   ANDERE Session desselben Agents.
6. Parity-Rows am Ende: „person store: memory profiles are per-human
  (agent-namespaced, cross-session merged) when socialMemory.personStore is
  enabled" + „legacy per-session profiles migrate into the person store
  idempotently".

**Verify**: `npm test` → all pass; Parity fully covered.

## Test plan

Siehe Step 4. Muster: bestehende social-memory-Tests (Temp-stateDir, Fake-llm,
Clock-freie ts-Params).

## Done criteria

- [ ] `rg -n "personStore" lib/config.js lib/social-memory.js openclaw.plugin.json` → Treffer
- [ ] `rg -n "legacy-sessions" lib/social-memory.js` → Treffer (Migration)
- [ ] `npm test` exit 0 inkl. Migration/Tenancy-Cases; Parity fully covered
- [ ] `git status` nur In-Scope-Dateien
- [ ] `plans/README.md` Status-Row aktualisiert

## STOP conditions

- Ein bestehender social-memory-Test verankert die Session-Datei-Form als
  Verhalten auf eine Weise, die nicht per default-false erhalten bleibt →
  STOP mit Testname.
- Die Merge-Semantik von extract (parsed.people gewinnt) kollidiert mit
  der geteilten Profil-Mutation in einem existierenden Race-Test → Report
  (nicht mit Locks improvisieren — Design-Entscheidung).
- pathSafe-Kollision: zwei verschiedene sessionKeys mappen auf denselben
  pathSafe-Namen und der Migration-Fallback liest sie als eine Datei →
  Report (bekanntes pathSafe-Risiko, muss bewusst entschieden werden).

## Maintenance notes

- Operator-Schritt nach Landung (KEIN Code): (1) hori-wa-DM-Profil mit
  contactsPath versehen, damit DM-Sender als echte Namen auflaufen
  (Autoconfig-Hinweis existiert bereits); (2) live config
  `socialMemory.personStore: true` setzen; (3) Backup von state/social-memory
  vor dem Flip (Migration verschiebt nur, löscht nichts).
- Namens-Kollisionen (zwei Menschen mit gleichem Kontakt-Namen) conflaten
  — contacts.md ist vom Operator kuratiert; Grenze dokumentiert.
- Der 64-KB-Oversize-Guard wird pro Agent wirksamer (eine Datei pro Agent
  statt pro Session) — maxPeople 50 bleibt die primäre Kappe.
- Plan 020 (schemaV2-Felder) und 021 (Recall v2) bauen auf diesem Store auf.
