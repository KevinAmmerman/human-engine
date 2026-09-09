# Plan 006: Multi-Tenant-Verlässlichkeit abschließen — Onboarding-Runbook, Autoconfig-Validierung, Vertrags-Matrix, Live-Rollout-Checkliste

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git -C ~/human-engine diff --stat e9216df..HEAD -- lib/ bin/ test/ wiki/ AGENTS.md`
> On mismatch beyond Plans 001–005's own changes: STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (advisory/log-only Code + Doku; Live-Config-Änderung ist separater Operator-Schritt mit Rollback)
- **Depends on**: plans/001, plans/002, plans/003, plans/004, plans/005 (alle)
- **Category**: dx
- **Planned at**: commit `e9216df`, 2026-09-09

## Why this matters

Nach 001–005 ist Multi-Tenancy im Code — aber der Weg „neuen Agent oder
neue WhatsApp-Gruppe hinzufügen" ist nirgends als Runbook dokumentiert,
Fehlkonfigurationen schlagen still ein (leerer contacts-Load = stiller
no-op), und die Release-Vertrags-Matrix (Parity) testet keine einzige
Multi-Tenant-Zusicherung. Dieser Plan schließt die Welle ab: Validierung
beim Start (laut statt still), ein Runbook, das Onboarding zu einem
deklarativen Akt macht, Parity-Rows für Isolation, und eine
Live-Rollout-Checkliste mit Kill-Switches — damit das Ergebnis
zuverlässig läuft, nicht nur in Tests.

## Current state

- `lib/autoconfig.js` (komplett, 15 Zeilen): nur drei advisory warns
  (API-key-Hinweis, `hooks.allowConversationAccess`-Check, BotFather-
  Reminder). Validiert KEINE Plugin-Config. Aktiviert via
  `cfg.autoconfig: true` → index.js:150-152.
- Still-Fail-Modi (aus 001–005/audit belegt):
  - `contactsPath` fehlbar → `loadContacts` returnt null still
    (lib/contacts.js:41-43) → Sender heißen `member-XXXX`, @-Mentions
    an Agent-Contact-IDs greifen nicht.
  - `soulPath` fehlbar → persona fällt auf `~/.openclaw/SOUL.md` zurück
    (persona.js:12) → falsche/leere Persona.
  - Profile-Key vertippt → Strict-Schema lehnt ab (laut, gut); Profil
    für Agent nicht in `agents`-Allowlist → still wirkungslos.
- `test/parity-matrix.mjs`: 54 Rows nach Plan 005. AGENTS.md sagt
  „656 pass / 0 fail" und „40/40" — BEIDES veraltet (live: 839 Tests/
  Parity 51/51 vor dieser Welle; Repo-Wiki human-engine sagt 820/46
  per 2026-09-04). Die AGENTS.md-Regel sagt: „update this line only
  when it changes structurally" — eine solche Änderung passiert HIER.
- Wiki-Konvention: `wiki/operations/*.md` (Beispiel:
  `wiki/operations/environment.md`), hausstil kurz, tabellenlastig.
- Live-Rollout-Konvention: Deploy-Order Code-vor-Config (Plan 586
  Step 5), Backup der openclaw.json vor Änderung (586 Step 6), Log-Beweise
  via `grep -E "human-engine|decision=" /tmp/openclaw/openclaw-$(date -u +%F).log`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Tests | `cd ~/human-engine && npm test` | all pass, 0 fail |
| Parity | `cd ~/human-engine && node test/parity-matrix.mjs --check` | `55/55 covered`, exit 0 |
| Count | `cd ~/human-engine && npm test 2>&1 | grep -E "^# (tests|pass|fail)"` | aktueller Stand für AGENTS.md-Zeile |
| Autoconfig | `cd ~/human-engine && node --test test/autoconfig.test.js` | all pass |

## Scope

**In scope**:
- `~/human-engine/lib/autoconfig.js`
- `~/human-engine/test/autoconfig.test.js`
- `~/human-engine/test/parity-matrix.mjs` (eine neue Row)
- `~/human-engine/test/e2e-local.test.js` (onboarding-e2e describe)
- `~/human-engine/wiki/operations/onboarding-multi-tenant.md` (NEU)
- `~/human-engine/wiki/quickstart.md` + `wiki/operations/environment.md`
  (Verweise + State-Tabelle-Pflege)
- `~/human-engine/AGENTS.md` (nur die Test-Zeile)

**Out of scope**:
- Live-Config `~/.openclaw/openclaw.json` (Operator; Checkliste liegt im
  Runbook, wird hier NICHT ausgeführt)
- ALLE lib-Module außer autoconfig.js
- `bin/followup-gate.mjs`, Cron-Payloads

## Git workflow

- Branch: `advisor/006-onboarding-hardening`
- Commit pro Step; Stil `plan 006: …`. PUBLIC repo — Runbook-Beispiele
  NUR mit fake Pfaden (`/srv/openclaw/workspace/agents/<agent>/…`-Form
  ist ok als SCHEMA, keine echten Dateiinhalte).

## Steps

### Step 1: Autoconfig-Validierung (advisory, nur log.warn)

In `warnStartupConfig(cfg, hostConfig, log)` ergänzen (unter Beibehaltung
der drei bestehenden warns):

1. Profil-Integrität (für jeden Key in `cfg.agentProfiles`):
   - `contactsPath` leer/unset → warn `no contactsPath in agentProfiles["<id>"] — sender names fall back to member-XXXX and @-mention triggers by contact id stay off`;
   - `soulPath` leer → warn (fällt auf globale SOUL.md zurück);
   - ID nicht in `cfg.agents`-Allowlist (wenn Allowlist nicht leer) →
     warn `profile exists but agent not in agents allowlist — profile is inert`.
2. Allowlist-Weite: Agent in `agents`, ABER ohne Profil UND
   `agentProfiles` nicht leer → warn `agent "<id>" runs on GLOBAL identity (no profile) — add an agentProfiles entry for full isolation`.
3. `naturalize.disableDM` + `socialLearning.perSessionCard:false`
   Kombination → Hinweis warn (Karte kollabiert pro Agent — Semantik
   Plan 004).
4. NIE throw, NIE schreiben (Hauskonvention advisory-only, Parity-Row 25).

**Verify**: neue autoconfig-Tests (Test plan); `node --test test/autoconfig.test.js` → pass.

### Step 2: E2E — Onboarding-Simulation

`test/e2e-local.test.js` neuer describe „onboarding" (fake Werte
durchgehend):

1. **Case A — „Neuer Agent in 3 Dateien"**: leeres stateDir; cfg mit
   allowlist [agent-a, agent-c] + agentProfiles für beide; fake
   contacts.md/SOUL.md je Agent (tmp). Nachricht von Kontakt-ID aus
   agent-c's contacts.md mit agent-c's Namen im Text → speak path=hard;
   decide-Persona enthält agent-c's SOUL; Card-Injektion leer (frisch)
   → nach 5 Messages Refresher angestoßen (fake engine zählt Aufrufe).
2. **Case B — Autoconfig fängt Tippfehler**: Profil für `agent-c`, aber
   Allowlist nur [agent-a] → beim Startup-Lauf (warnStartupConfig)
   „inert"-Warnung; Zeitgleich Verhalten: agent-c's Hooks no-op
   (allowlist) — bewusst dokumentierter Still-Fail wird SICHTBAR.
3. **Case C — Zwei Gruppen, ein Agent**: zwei Gruppen-SessionKeys
   desselben Agents → getrennte observed-Files/Memory-Scopes
   (`state/observed/`-Injektion via factory stateDir; Scope-Strings per
   scope.js), keine Transcript-Bleed über Gruppen (decide-ctx-Zähler
   pro Session).

**Verify**: `node --test test/e2e-local.test.js` → all pass.

### Step 3: Parity-Row 55

```js
{ id: 55, behavior: "onboarding a new agent/group is declarative (profiles + files only) and misconfiguration warns loudly at startup (autoconfig), incl. inert-profile and missing-paths cases",
  tags: ["onboarding"] },
```
Tag-Substring-Regel beachten (Stil Plan 586).

**Verify**: `node test/parity-matrix.mjs --check` → `55/55 covered`, exit 0.

### Step 4: Runbook `wiki/operations/onboarding-multi-tenant.md`

Inhalt (kurz, tabellenlastig, Hausstil):

1. **Neuer AGENT** (checkliste): (a) Workspace: `contacts.md` + `SOUL.md`
   anlegen; (b) Config: Agent-ID in `agents`-Allowlist + Eintrag in
   `agentProfiles` (agentName/agentAliases/contactsPath/soulPath,
   optional Feature-Overrides); (c) Gateway-Restart; (d) Verifikation:
   Autoconfig-Warns leer für die ID, Log `decision=…` Zeilen mit dem
   neuen sessionKey-Präfix `agent:<id>:…`, erste Hard-Trigger-Antwort
   in der Zielgruppe.
2. **Neue WhatsApp-GRUPPE / -CHANNEL für bestehenden Agent**: (a)
   Gruppenmitglieder in der relevanten `groupAllowFrom`-Liste
   (channels.whatsapp — SILENT-DROP-Warnung aus environment.md zitieren);
   (b) keine Plugin-Config nötig — SessionKey leitet ab (scope.js);
   (c) Verifikation: `message_received fired sk=agent:<id>:whatsapp:group:…`
   im Log; optional Gruppen-Knobs via Profile-`channels`-Pfad (falls
   Plan 002-Follow-up existiert, sonst global).
3. **Rollback/Kill-Switches**: `enabled:false` (alles), Feature-Flags
   (`proactive.enabled`, `dmProactive.enabled:false` + Cron disable —
   Muster Plan 536 Kill-Switch), Profil-Eintrag entfernen = Agent fällt
   auf global zurück.
4. **Shadow-Erstanlauf für neue Agenten**:empfehlung — neue
   Agenten/Gruppen mit `proactive.shadow:true` und `dmProactive.shadow:true`
   im PROFIL-Override anlassen (Profil-Override-Muster aus 002), bis
   Log-Review ok.

**Verify**: `grep -c "##" wiki/operations/onboarding-multi-tenant.md` ≥ 4;
Links aus quickstart.md + environment.md setzen (je 1 Zeile).

### Step 5: AGENTS.md-Test-Zeile aktualisieren

Nur die Zeile „Tests: `npm test` — … (N pass / 0 fail as of this doc…)"
und Parity-Zahl auf die neuen Werte (aus dem Count-Command). KEINE
anderen AGENTS.md-Änderungen.

**Verify**: `grep -n "pass" AGENTS.md` → Zahl == Count-Command-Ergebnis;
Parity-Zahl == 55.

### Step 6: Live-Rollout-Checkliste (Operator-Schritt, im Runbook endend)

Im Runbook unter „Live-Rollout (Operator)" einfügen — AUSFÜHREN tut ihn
der Operator NACH dem Merge, nicht der Executor:

1. `git -C ~/human-engine log --oneline -1` (Welle komplett) → Gateway
   restart (`openclaw gateway restart`) → Log auf
   `human-engine:`-Startup-Fehler prüfen.
2. Backup: `cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak.mt-$(date -u +%Y%m%d-%H%M%S)`.
3. Erste Umstellung NUR Yuki-Profil (Global-Keys → Profil des
   Bestands-Agenten; Verhalten muss IDENTISCH bleiben) + 24 h
   Beobachtung (Log-Marker wie in human-engine-wiki Verifikations-Sektion).
4. Danach zweiter Agent/Gruppe nach Runbook-Checkliste; Shadow an.
5. Rollback: Backup zurückspielen oder Profile-Keys entfernen; alle
   Codeschritte sind Backward-compat (leere Profiles = Status quo ante).

**Verify** (Executor): Runbook-Text enthält die 5 Punkte mit Befehlen
(grep).

## Test plan

- Unit (autoconfig.test.js): jede neue Warn-Regel je 1 positiv/negativ
  Case; advisory-only (wirft nicht, schreibt nichts).
- E2E (e2e-local.test.js): onboarding-Cases A–C.
- Verification: `npm test` all pass; Parity 55/55.

## Done criteria

- [ ] autoconfig validiert Profile (Warn-Regeln) — advisory-only (Test belegt)
- [ ] E2E onboarding describe grün (3 Cases)
- [ ] Parity `55/55 covered` exit 0
- [ ] Runbook existiert, verlinkt von quickstart + environment
- [ ] AGENTS.md-Test-Zeile aktualisiert (pass/parity korrekt)
- [ ] `git status` nur In-Scope-Dateien
- [ ] `plans/README.md` Status-Row aktualisiert

## STOP conditions

- Drift in autoconfig.js/index.js:150-152.
- Eine neue Warn-Regel würde bei der LIVE-Config feuern, während du die
  Tests lokal baust (live-Config NICHT einlesen — nur cfg-Fakes in
  Tests; falls du doch live liest: stoppen).
- Parity-Row 55 kann ohne Verhaltens-Assertion gebaut werden (nur
  Doku-Check) → Row-Text schärfen statt nur benennen; wenn das nicht
  testbar bleibt: melden.
- AGENTS.md weicht strukturell von der erwarteten Ein-Zeilen-Änderung ab
  → melden.

## Maintenance notes

- Nach diesem Plan ist der Onboarding-Pfad geschlossen: 001 (Parser) →
  002 (Config) → 003 (Identity) → 004 (Cards) → 005 (Proactive) → 006
  (Verlässlichkeit). Neue Feature-Flags MÜSSEN ab jetzt in
  `resolveAgentConfig`-Profile-Merge-Key-Liste gepflegt werden
  (PROFILE_MERGE_KEYS) — sonst sind sie nicht pro Agent übersteuerbar.
- Reviewer-Schwerpunkt: advisory-only (kein throw/schreiben), Runbook
  enthält KEINE echten Nummern/Pfade, AGENTS.md minimal geändert.
- Erst NACH Live-Rollout-Schritt 3 (24 h) gilt die Welle als abgeschlossen;
  davor Status IN PROGRESS in plans/README.md belassen.
