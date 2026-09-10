# Plan 033: Self-Voice live schalten — `/soul voice`-Governance, Persona-Render, Refresh-Trigger

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — SKIP (reviewer maintains the index).
>
> **Drift check (run first)**: `git -C ~/human-engine diff --stat <base>..HEAD -- lib/self-voice.js lib/persona.js index.js lib/naturalize.js lib/gate.js`
> Compare against the "Current state" excerpts; apply intent to LIVE code.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (Command-Wiring + Persona-Render berühren den Live-Prompt; Guard: Karte nur nach Owner-ACCEPT aktiv)
- **Depends on**: Plan 031 (Prototyp lib/self-voice.js — gelanded)
- **Category**: direction
- **Planned at**: commit `<base>`, 2026-09-10

## Why this matters

Die einzige gelernte „Stimme" spiegelt die GRUPPE (voice card); die
Persönlichkeit lebt in der statischen SOUL.md. Der Self-Voice-Prototyp
(Plan 031) extrahiert aus den EIGENEN Replies eine per-Agent-Stimme — aber
ohne Wiring passiert nichts: kein Command, kein Render, kein Refresh. Dieser
Plan schaltet die Governance-Kette live: Extract läuft im Hintergrund →
Diff-Preview → **Owner accept** (nie still übernehmen) → Karte färbt den
Persona-Prompt vor der Gruppen-Karte. Ergebnis: derselbe Charakter in allen
Räumen desselben Agents.

## Current state

Plan 031 hat gebaut (verify im Live-Code):

- `lib/self-voice.js` — `createSelfVoice({cfg, engine, stateDir, observedStore, log})`
  mit `refreshFor(agentId, sessionKey)` (Volumen-Guard ≥30 eigene Zeilen,
  Extract → `pending`), `snapshotFor(agentId)` (liefert `active` oder null),
  `accept(agentId)` (pending → active + .bak), `reset(agentId)`. Off-Vertrag:
  `selfVoice.enabled !== true` → alles no-op. State:
  `state/self-voice/<agentId>.json` (version 1, 0600).
- `lib/local-engine.js` — `extractSelfVoice({transcript, agentId})`
  (maxTokens analog voice-card, purpose `human-engine-self-voice`).
- `lib/local-prompts.js` — `buildSelfVoiceExtractPrompt` +
  `renderSelfVoiceBlock`.
- `lib/persona.js` — `setVoiceCardGetter`-Pattern existiert (Z. ~32-34),
  `buildPersonaPrompt` = SOUL → voiceCard → ANTI_TELL → style-stats.
- `index.js` — `/soul`-Command existiert (registerCommand, handler: sub
  muss mit "enhance" beginnen, sonst Usage-Text).
- `lib/naturalize.js` — `persistOwnReply(sk, text, agentName)` in flush.

Verbraucher-Vertrag (Report 031 §3/§4): Reihenfolge im Persona-Prompt = SOUL
→ **Self-Voice** → Gruppen-Karte → ANTI_TELL → Style-Stats; Render-Zeile
`Your own voice (keep it consistent): <card>`, mit wrapUntrusted; Karte PER
AGENT (nicht per Session); Never-mention-Clause im Block.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Unit | `node --test test/self-voice.test.js test/persona.test.js` | all pass |
| Tests | `npm test` | all pass, 0 fail |
| Parity | `node test/parity-matrix.mjs --check` | fully covered, exit 0 |

## Scope

**In scope**:
- `lib/persona.js` (selfVoiceGetter + Render-Sektion)
- `lib/self-voice.js` (`onOwnReply(agentId, sk)` — cadence-gated Refresh-Trigger)
- `lib/naturalize.js` (EIN Aufruf nach persistOwnReply; selfVoice-Dep)
- `index.js` (createSelfVoice-Instanz, Getter-Registrierung, `/soul voice`-Subcommand)
- `lib/gate.js` (EINE Zusatzzahl im decide-ctx-Log: selfVoiceLen)
- Tests: `test/self-voice.test.js`, `test/persona.test.js`, `test/e2e-local.test.js` (falls Fake-Anpassung nötig), `test/parity-matrix.mjs` (eine Row)

**Out of scope**:
- `lib/config.js`/Schema (`selfVoice.enabled` existiert; KEIN neuer Key außer
  ggf. `selfVoice.refreshMinutes` — nur wenn trivial)
- Accept/Reset-Automatik (Owner-gated, per Command)
- Extract-Prompt-Inhalt (031-geprüft)

## Git workflow

- Branch: `advisor/033-self-voice-wiring`; Commits `plan 033: …`

## Steps

### Step 1: persona.js — Self-Voice-Sektion

1. `setSelfVoiceGetter(fn)` + Modul-Getter (Muster `setVoiceCardGetter`).
2. In `buildPersonaPrompt` ZWISCHEN soul und voiceCard:
   ```js
   const selfVoice = typeof selfVoiceGetter === "function" ? selfVoiceGetter(agentId) : null;
   if (selfVoice) parts.push("Your own voice (keep it consistent):\n" + wrapUntrusted(selfVoice));
   ```
   (wrapUntrusted importieren — 010-Muster.)

**Verify**: `node --test test/persona.test.js` → pass (neue Cases Step 5).

### Step 2: self-voice.js — onOwnReply-Trigger

Ergänze `onOwnReply(agentId, sk)`: cadence-gated (`selfVoice.refreshMinutes`
default 60; lastRefresh pro Agent in-memory Map, cap 256) →
`setTimeout(() => refreshFor(agentId, sk), 0)` (unref) — NIEMALS Hot-Path.
Export im createSelfVoice-Return. Dedupe: laufender Refresh pro Agent
(in-memory Set).

**Verify**: `node --test test/self-voice.test.js` → pass.

### Step 3: Wiring (index.js + naturalize)

1. `index.js`: `const selfVoice = createSelfVoice({ cfg, engine, stateDir, observedStore, log })` NACH observedStore; `persona`-Objekt erhält Getter-Registrierung:
   `setSelfVoiceGetter((agentId) => selfVoice.snapshotFor(agentId))`.
2. `createNaturalize({ …, selfVoice })` — in flush NACH `persistOwnReply`:
   `try { selfVoice?.onOwnReply?.(agentIdFromSessionKey(sk), sk); } catch {}`.
3. `/soul`-Command erweitern: `voice`-Subcommand —
   - `/soul voice` → Status: active vorhanden? (Zeichenlänge) + pending-Diff (alt vs neu Zeilen-Zahl + kurzer Text-Head beider, redacted/fake-safe),
   - `/soul voice accept` → `selfVoice.accept(agentId)` → Bestätigungstext („Stimme übernommen (N → M Zeichen)"),
   - `/soul voice reset` → `selfVoice.reset(agentId)` → Bestätigung.
   `agentId` aus `ctx?.agentId` (Muster `/soul enhance`). Enhance-Pfad unverändert.

**Verify**: `node --test test/register.test.js test/self-voice.test.js` → pass (Command-Cases Step 5).

### Step 4: decide-ctx-Log (Messung, Report 031 §6)

In `lib/gate.js` — im Gruppen-Zweig vor dem decide-Call, wo `decide-ctx`
geloggt wird: `selfVoiceLen=<Zeichen von persona.snapshotFor(agentId) || 0>`
anhängen. (Getter-Zugriff über das persona-Objekt; fail-open try/catch.)

**Verify**: `node --test test/gate.test.js` → pass.

### Step 5: Tests + Parity

1. persona: aktive Karte erscheint ZWISCHEN soul und Gruppen-Karte, wrapped;
   inaktiv → keine Sektion.
2. self-voice: onOwnReply respektiert Cadence (zweiter Call <60 min → kein
   Refresh), Volumen-Guard unverändert.
3. Command-Fake: `/soul voice accept` ohne pending → freundlicher Noop-Text;
   mit pending → accept-text; reset → Bestätigung.
4. decide-ctx: selfVoiceLen=0 ohne Karte, >0 mit Fake-Karte.
5. Parity-Row am Ende: „self-voice wiring: /soul voice preview/accept/reset
  governs the agent's own learned voice into the persona (before the group
  card), refresh cadence off the hot path".

**Verify**: `npm test` → all pass; Parity fully covered.

## Done criteria

- [ ] `rg -n "setSelfVoiceGetter|onOwnReply" lib/` → Treffer in persona/self-voice/naturalize
- [ ] `/soul voice` im register.test verankert
- [ ] `npm test` exit 0; Parity fully covered
- [ ] plans/README.md (vom Reviewer)

## STOP conditions

- Die 031-API weicht ab (refreshFor/snapshotFor/accept/reset fehlen oder
  andere Signaturen) → STOP mitIst-Zustand.
- Persona-Reihenfolge-Tests (Plan-028-Args-Tests) brechen inhaltlich →
  Expectations erweitern ist ok; Verhaltensflip eines decide-eval-Szenarios
  → STOP (Karte sollte threshold-neutral sein — nur Konsistenztext).

## Maintenance notes

- Owner-Flow nach Deploy: `selfVoice.enabled: true` setzen → wartet auf
  ≥30 eigene Zeilen → `/soul voice` zeigt pending → **Kevin entscheidet
  accept/reset** (Geschmackssache, bewusst human-gated).
- Objektiv beobachtbar: `selfVoiceLen=N` im decide-ctx-Log.
- Parrot-Risiko: Caps im Extract-Prompt (031); wenn Wiederholungen auffallen
  → reset + Extract-Prompt-Tuning.
