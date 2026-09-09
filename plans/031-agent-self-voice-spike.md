# Plan 031: Agent-Self-Voice Spike — Design für eine EIGENE Stimme des Agents (nicht nur Raum-Spiegel)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`. Deliverable: `plans/031-self-voice-spike-report.md`
> (+ optionaler Prototyp hinter Config-Off, NICHT live).
>
> **Drift check (run first)**: `git -C ~/human-engine diff --stat c4e148b..HEAD -- lib/voice-card.js lib/persona.js lib/observed-store.js lib/soul.js`
> On mismatch: STOP condition.

## Status

- **Priority**: P2
- **Effort**: M (Design + Prototyp, kein Live-Bau)
- **Risk**: MED (gelernte Selbst-Stimme kann driften/überfitten — deshalb Design-Gates: Diff-Preview + Confirm + Reset)
- **Depends on**: 026 (Style-Stats filtern eigene Zeilen — der Self-Voice braucht GEGENTEIL: eigene Zeilen als QUELLE; die Pläne konkurrieren nicht, 026 filtert die GRUPPEN-Statistik, 031 nutzt eine eigene Selektion)
- **Category**: direction (spike)
- **Planned at**: commit `c4e148b`, 2026-09-09

## Why this matters

Die einzige dynamische „Voice"-Maschinerie lernt den RAUM (voice-card:
„Analyze how this group talks"), nicht den Agenten. Die Persönlichkeit
lebt in einer statischen, handgepflegten SOUL.md (auto-Enhance live aus).
Folge: Der Agent konvergiert zum Stil des Raums (Zwei Agenten im selben
Raum -> gleiche Stimme), statt einen eigenen Charakter zu tragen —
das Gegenteil von „Persönlichkeit, die menschlich wirkt". Der Spike
designed ein „Self-Voice Card"-Gegenstück: aus den EIGENEN Replies
(observed store persistiert sie seit Plan 528) einen kompakten
Stil-Kern lernen, per Diff-Vorschlag + Owner-Confirm übernehmen,
als erste Prompt-Sektion VOR der Gruppen-Karte rendern.

## Current state

- `lib/voice-card.js:266` — extractVoiceCard über `buildTranscript`
  (GRUPPEN-Transcript aus event.messages; Fenster 100, extract-Prompt
  „Analyze how this group talks"); Karten-Buckets per Agent
  (stateByAgent, Plan 004); Rendering via renderPromptBlock.
- `lib/observed-store.js` — `readObserved(sk, last)` liefert
  `{speaker, text, ts}` inkl. EIGENER Replies (persistOwnReply,
  naturalize.js:151-161, speaker = agentName).
- `lib/soul.js` — Enhance-Pattern mit .bak-Backup + Marker-Sektion +
  `/soul`-Command (index.js:168-180) — das Lifecycle-Vorbild für
  „Learn + Preview + Confirm".
- `lib/persona.js:41-57` — buildPersonaPrompt-Reihenfolge: SOUL →
  voiceCard (Raum) → ANTI_TELL → Style-Stats.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Tests | `npm test` | all pass, 0 fail |

## Scope

**In scope**:
- Design-Report `plans/031-self-voice-spike-report.md` (NEU — Deliverable)
- Optionaler Prototyp hinter `selfVoice.enabled: false` (Config-Key +
  lib/self-voice.js + Tests) — KEIN Live-Wiring jenseits der
  Persona-Reihenfolge, KEINE Auto-Übernahme

**Out of scope**:
- Auto-Apply der gelernten Stimme (immer Owner-gated)
- Gruppe-Karte ersetzen (Self-Voice kommt ZUSÄTZLICH davor)
- SOUL.md-Umschreiben

## Git workflow

- Branch: `advisor/031-self-voice-spike`
- Commits nur wenn Prototyp gebaut wird; Stil `plan 031: …`

## Steps

### Step 1: Design-Report schreiben

`plans/031-self-voice-spike-report.md` mit diesen Abschnitten:

1. **Quelle**: eigene Replies aus `observedStore.readObserved` gefiltert
   auf speaker == agentName (Alias-tolerant, lowercase; Plan 006-Self-
   Filter-Mechanik wiederverwenden). Mindest-Volumen-Proxy: ≥30 eigene
   Zeilen pro Agent, sonst kein Learn-Lauf (Live-Messung: Zeilen in
   state/observed zählen, PII-safe wie Plan 025 Step 2).
2. **Lern-Loop** (Prototyp-Form): `lib/self-voice.js`
   `createSelfVoice({cfg, engine, stateDir, observedStore, log})` mit
   `refreshFor(agentId, sessionKey)` — Extract-Prompt (NEU, analog
   buildExtractPrompt, aber „Analyze how THIS AGENT talks from its own
   past messages; return its distinctive voice (signature phrases,
   casing, rhythm, reaction patterns) STRICT JSON") über die eigenen
   Zeilen; Output → selfVoice-Bucket im Voice-Card-Cache-Format (per
   Agent — stateByAgent-Mechanik von Plan 004 wiederverwenden).
   Refresh-Cadence: `refreshMinutes` (default 60), NIEMALS im
   Hot Path (setTimeout wie voice-card spawnRefresh okay).
3. **Governance-Gates** (der eigentliche Punkt):
   - Neue/stärkere Karte → NICHT automatisch rendern; Diff-Preview
     loggen (alt vs neu, Zeilen-Zahl) + `/soul voice`-Command-Ausgabe
     (index.js-Command-Pattern) → Owner confirmiert mit
     `/soul voice accept` (Schreibt activeCard + .bak) oder verwirft.
   - Reset: `/soul voice reset` → activeCard löschen (Stimme stirbt
     kontrolliert).
   - Never-mention-Clause im Render-Block (wie Mood: interne Farbe,
     kein Zitat).
4. **Rendering**: persona.js buildPersonaPrompt — bei aktiver Self-Voice:
   Sektion VOR der Gruppen-Karte: „Your own voice (keep it consistent):
   <card>" (wrapUntrusted — gelernt aus eigenen Outputs ist trustworthy,
   aber einheitliche Wrapping-Konvention). Gruppen-Karte bleibt — sie
   beschreibt den Raum, Self-Voice den Agenten.
5. **Risiken**: Overfit („Signature phrases" → Parrot-Loop) — Mitigation:
   Caps (≤6 Phrasen), Temperatur 0.2, Mindest-Volumen; Cross-Group-
   Konsistenz: Karte PER AGENT (nicht per Session) → gleiche Stimme in
   allen Räumen desselben Agents — das ist der Wunscheffekt.
6. **Messung**: „Fühlt sich der Agent an wie derselbe?" — Kriterium im
   Report: Owner-Review nach 3 Tagen Gruppenbetrieb (Subjektiv-Test),
   PLUS objektiv: Vorschlag, wie Self-Voice im decide-ctx-Log sichtbar
   wird (Card-Länge je Speak).

### Step 2: Prototyp (optional, hinter Config-Off)

Nur wenn Step 1 sauber: `selfVoice.enabled: false` + lib/self-voice.js
mit refreshFor + snapshotFor + accept/reset-Zustand (Datei
`state/self-voice/<agentId>.json`, version 1, 0600 — Plan-004-Konvention).
Tests: extract über Fake-llm, accept/reset-Semantik, Off-Vertrag (keine
Dateien, keine Renders). KEIN Command-Wiring in index.js im Spike (das
ist Follow-up-Plan-Material).

**Verify**: `npm test` → pass inkl. neuer self-voice-Tests.

## Test plan

Prototyp-Tests (falls gebaut): Off-Vertrag, Extract/Preview/Accept-Loop,
Reset. Muster: voice-card.test.js.

## Done criteria

- [ ] `plans/031-self-voice-spike-report.md` existiert (Quelle, Loop,
      Governance, Rendering, Risiken, Messung)
- [ ] Falls Prototyp: `rg -n "selfVoice" lib/config.js openclaw.plugin.json` + `test -f lib/self-voice.js`, `npm test` grün
- [ ] `plans/README.md` Status-Row aktualisiert

## STOP conditions

- observed-Store bietet nicht verlässlich genug eigene Zeilen (Rotation
  200/Session könnte eigene Replies früh verdrängen) → als Fund im
  Report dokumentieren (Option: eigener Self-Reply-Speicher) — NICHT
  eigenmächtig observed-store-Rotation ändern.
- Extract-Qualität in Tests erkennbar schlecht (Fake-LLM-JSON unbrauchbar
  strukturiert) → Prompt-Design im Report iterieren statt Prototyp bauen.

## Maintenance notes

- Der Follow-up-Bau (Command-Wiring + Live-Flip) ist ein eigener Plan —
  Nummer im Report notieren.
- Governance-Prinzip für ALLE künftigen Selbst-Lern-Features: Preview +
  Accept + Reset, niemals still übernehmen. Das ist der eigentliche
  Ertrag dieses Spikes über die Stimme hinaus.
