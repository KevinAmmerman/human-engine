# Plan 008: `agentId` an alle `llm.complete`-Calls mitgeben — korrektes Modell-Routing + Audit statt Host-Ratebei

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git -C ~/human-engine diff --stat d40fc28..HEAD -- lib/ test/`
> On mismatch with the "Current state" excerpts: STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (SDK-Parameter ist optional; ohne Übergabe bleibt Host-Verhalten wie heute)
- **Depends on**: none (baut auf 001/003 scope.js + per-agent Auflösung auf)
- **Category**: bug
- **Planned at**: commit `d40fc28`, 2026-09-09

## Why this matters

Live-Befund (Gateway-Log 15:22:53 UTC): Der Humanize-Call für eine
`hori-wa-public-group`-Session trägt die Audit-/Routing-Metadaten
`"caller": {…, "agentId": "hori-wa"}` — der FALSCHEN Agent. Ursache: Das
Plugin übergibt bei `llm.complete` NIEMALS einen `agentId`; der Host leitet
den Caller aus dem Async-Kontext ab — und der Flush-Pfad (Bubble-Timer)
läuft außerhalb des Agent-Turns, verliert den Kontext und fällt auf den
Default-Agenten (`hori-wa`) zurück. Folge heute: falsches Audit; bei
divergierenden Agent-Modellen/Budgets künftig falsches Modell-Routing der
Humanize-Calls.

Die SDK-Definition (`openclaw/dist/agent-harness-runtime-*.d.ts`,
`LlmCompleteParams`) akzeptiert explizit:
```ts
/** Agent whose model/credentials to use. Session-bound capabilities may disallow overrides. */
agentId?: string;
```
Dieser Plan übergibt `agentId` an ALLE `llm.complete`-Call-Sites — abgeleitet
aus sessionKey/scope, dort wo der Kontext sicher verfügbar ist.

## Current state

Call-Sites (grep `llm.complete` bei `d40fc28`, 9 Stück):

| # | Datei:Zeile | Zweck | Kontext mit agentId? |
|---|-------------|-------|----------------------|
| 1 | `lib/local-engine.js:69` | `human-engine-decide` | `sessionKey`-Param vorhanden |
| 2 | `lib/local-engine.js:126` | `human-engine-humanize` | `sessionKey`-Param vorhanden |
| 3 | `lib/local-engine.js:177` | `human-engine-extract` (Voice-Card) | AUFRUFER `lib/voice-card.js` `spawnRefresh(sessionKey, …)` hat sessionKey — `extractVoiceCard({transcript})`-Signatur muss agentId-Param bekommen |
| 4 | `lib/local-engine.js:206+` | `human-engine-soul` (`enhancePersona`) | Aufrufer `lib/soul.js` (`/soul`-Command, `maybeAutoEnhance`) — agentId optional (ctx.agentId, sonst weglassen = Host-Default) |
| 5 | `lib/local-engine.js:~240` | `human-engine-regen` (`regenerateReply`) | `sessionKey`-Param vorhanden |
| 6 | `lib/dm-proactive.js:791` | render | `candidate.agentId` vorhanden |
| 7 | `lib/proactive.js:612` | proactive send | scope/session im Kontext (`scopeFor` = `agentId::sessionKey`) |
| 8 | `lib/social-memory.js:214` | `human-engine-memory` | `scope`-Param = `"<agentId>::<sessionKey>"` → agentId = vor dem ERSTEN `::` (Muster: `parseScope` in social-memory.js:34-38 existiert bereits) |
| 9 | `lib/mood.js:189` | Mood-Appraisal | `agentId` im Kontext (mood.js hat agentId-Kontext per Plan 570) |

Helfer: `agentIdFromSessionKey(sk)` aus `lib/scope.js` (import-fertig).
Konventionen: Log-Präfix `human-engine:`; Tests node:test inline fakes —
die Fake-`llm.complete`-Objekte in den Tests MÜSSEN um einen opts-Capturer
ergänzt werden (Muster: bestehende Tests bauen `llm: { complete: async () => … }`
— stattdessen `llm: { complete: async (opts) => { captured.push(opts); return …; } }`).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Tests | `npm test` (in worktree) | all pass, 0 fail |
| Parity | `node test/parity-matrix.mjs --check` | `56/56 covered`, exit 0 |
| Unit | `node --test test/local-engine.test.js test/naturalize.test.js test/social-memory.test.js test/dm-proactive.test.js test/proactive.test.js test/mood.test.js test/voice-card.test.js` | all pass |
| Grep-Check | `grep -rn "purpose:" lib/ | grep -v agentId` → jede purpose-Zeile hat agentId in derselben opts (manuell prüfen) | 9/9 Sites versorgt |

## Scope

**In scope**:
- `lib/local-engine.js` (5 Sites + Signatur-Params für extract/soul)
- `lib/voice-card.js` (agentId an extractVoiceCard)
- `lib/soul.js` (agentId an enhancePersona — optional)
- `lib/social-memory.js` (Site 8)
- `lib/dm-proactive.js` (Site 6)
- `lib/proactive.js` (Site 7)
- `lib/mood.js` (Site 9)
- `test/local-engine.test.js`, `test/voice-card.test.js`, `test/social-memory.test.js`, `test/dm-proactive.test.js`, `test/proactive.test.js`, `test/mood.test.js`, `test/e2e-local.test.js` (opts-Assertions)

**Out of scope**:
- `lib/naturalize.js` selbst (ruft nur engine.respond/regenerateReply auf — dort kommen die agentId-Params herein)
- `index.js` (nur falls ein Aufrufer-Signaturwechsel es erzwingt — dann MINIMAL)
- SDK/Host-Verhalten, Config-Schema (kein neuer Config-Key)

## Git workflow

- Branch: `advisor/008-llm-caller-agentid` (Worktree, gestapelt auf main)
- Commit pro logischer Einheit; Stil `plan 008: …`. PUBLIC repo.

## Steps

### Step 1: local-engine.js — Sites 1, 2, 5 + Signaturen für 3, 4

1. Import: `import { agentIdFromSessionKey } from "./scope.js";`
2. Sites mit `sessionKey`-Param (decide :69, humanize :126, regen ~:240):
   `agentId: agentIdFromSessionKey(sessionKey) || undefined` in die
   `llm.complete`-opts aufnehmen (direkt neben `purpose`).
3. Site 3: `extractVoiceCard({ transcript })` →
   `extractVoiceCard({ transcript, agentId })`; Aufrufer voice-card.js
   `spawnRefresh` leitet `agentIdFromSessionKey(sessionKey) || undefined`
   weiter; opts um `agentId` ergänzen.
4. Site 4: `enhancePersona({ persona, agentId })` — Aufrufer soul.js
   reicht optional durch (`/soul`-ctx.agentId / `maybeAutoEnhance` ohne
   agentId → undefined = Host-Default, wie heute).

**Verify**: `node --test test/local-engine.test.js test/voice-card.test.js test/soul.test.js` → pass (neue opts-Assertions).

### Step 2: Sites 6–9 (dm-proactive, proactive, social-memory, mood)

Je Site `agentId` in die opts (Kontext siehe Tabelle):
- dm-proactive.js:791: `agentId: candidate.agentId || undefined`
- proactive.js:612: agentId aus dem scope/session des Kandidaten ableiten
  (`scopeFor`-Format parsen — split am ersten `::`)
- social-memory.js:214: agentId aus `scope` (Muster parseScope Z. 34-38)
- mood.js:189: agentId aus dem vorhandenen Kontext

**Verify**: `node --test test/dm-proactive.test.js test/proactive.test.js test/social-memory.test.js test/mood.test.js` → pass.

### Step 3: Test-Assertions + E2E

1. In den Unit-Tests: Fake-llm um opts-Capture erweitern und je Funktion
   1 Case: `captured.opts.agentId === erwartete agentId` (und für
   sessionKey-lose Calls: `=== undefined`).
2. E2E (`test/e2e-local.test.js`): im bestehenden multi-agent describe
   einen Case: flush-Turn für agent-b → der humanize-llm.opts.agentId ist
   `agent-b` (das ist die REGRESSION zum Live-Befund „caller agentId:
   hori-wa").

**Verify**: `node --test test/e2e-local.test.js` → pass; `npm test` →
all pass; Parity 56/56.

## Test plan

Siehe Steps. Verification: `npm test` all pass; Parity 56/56 (keine neue
Row nötig — kein Verhaltens-Contract gegenüber der Gruppe ändert sich,
nur Host-Routing/Audit).

## Done criteria

- [ ] `grep -rn "purpose:" lib/*.js` → alle 9 Sites haben `agentId` in denselben opts
- [ ] `npm test` exit 0; Parity `56/56 covered`
- [ ] `git status` nur In-Scope-Dateien
- [ ] E2E-Case belegt: humanize-opts.agentId = session-agent (nicht hori-wa)

## STOP conditions

- Die Site-Tabelle passt nicht mehr (Drift).
- Die SDK-Option `agentId` wird vom Host im Test-Fake-Kontext anders
  behandelt (z. B. Fehler bei unbekanntem agentId) → melden.
- Ein bestehender Test bricht inhaltlich (nicht opts-Capture-bedingt) → melden.

## Maintenance notes

- Jetzt kann der Host je Agent Modell/Credentials korrekt routen — wenn
  künftig Agent-Modelle divergieren, ist das Humanize/Decide-Routing
  automatisch richtig.
- Reviewer-Schwerpunkt: extract/enhancePersona-Signaturänderungen an ALLEN
  Aufrufstellen; undefined-Pfade (Host-Default) für echte Global-Calls.
