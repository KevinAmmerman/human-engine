# Plan 031: Agent-Self-Voice Spike — Design Report

> **Status**: DESIGN HOLDS → Prototyp hinter `selfVoice.enabled: false` gebaut
> (siehe unten). Kein Live-Wiring, keine Command-Registrierung in index.js
> (das ist Follow-up-Plan 033, siehe letzter Abschnitt).
>
> **Executor**: deepseek-v4-flash-0731 · **Branch**: `advisor/031-self-voice`
> · **Base**: `8cbf2ef` (plan 030). Dieses Report basiert auf tatsächlich
> verifizierten Tool-Ergebnissen dieser Session (Tests: 1084 pass / 0 fail,
> Parity 77/77).

---

## 1. Quelle: eigene Replies aus dem observed-Store

**Tail-Read (Plan 013) ist die Quelle.** `createObservedStore` (lib/observed-store.js)
hat seit Plan 013 einen `readCache` (file → `{mtimeMs, size, out}`) plus
Tail-Logik: `readObserved(sessionKey, last)` liest die letzten `n*2` Zeilen
der Datei, parst sie, cached sie und gibt die letzten `n` zurück
(lib/observed-store.js:69-102). Rotation: bei >400 Zeilen werden die letzten
200 behalten (MAX_LINES=400, KEEP_LINES=200, lib/observed-store.js:5-6,44-67).
→ `readObserved(sk, 200)` liefert das komplette erhaltene Fenster (bis zu
200 Zeilen).

**Eigene Replies sind enthalten.** `persistOwnReply` (lib/naturalize.js:151-161)
schreibt bei jedem versendeten Reply-Payload `{speaker: agentName, text:
text.slice(0,300), ts}` in den observed-Store (`speaker = agentName`,
gekappt auf 300 Zeichen). Der Payload-Fluss stammt aus
`onReplyPayloadSending` (lib/naturalize.js:204-239).

**Filter auf eigene Zeilen (Alias-tolerant, lowercase).** Die Self-Voice
wählt aus den gelesenen Zeilen nur die mit
`speaker` ∈ {agentName, …agentAliases}, alles lowercase-vergleichen
(vgl. die Plan-026-Self-Filter-Mechanik in lib/persona.js:49-56, die exakt
dieselbe Namensmenge `[agentName, ...agentAliases]` lowercase aufbaut).
`resolveAgentConfigForSession` liefert die per-Agent-Namen (lib/config.js:159-161).

**Mindest-Volumen-Proxy (≥30 eigene Zeilen).** Ohne ausreichend Volumen
kein Learn-Lauf. Live-Messung PII-safe (nur Zeilen zählen, keine Texte
loggen — wie Plan 025 Step 2): Zeilen in `state/observed/<sk>.jsonl`
zählen und gegen den eigenen Namen filtern. Erst bei ≥30 eigenen Zeilen
wird `refreshFor` einen Extract-Prompt bauen. Unterschreitung → kein
Learn, kein State, kein Render.

**STOP-Bedingung 1 geprüft (Rotation könnte eigene Replies verdrängen).**
Bei 200/Session-KEEP könnte ein sehr aktiver Raum die eigenen Zeilen
verdrängen. Das ist als Fund dokumentiert: Im Prototyp-Design wirkt das
≥30-Volumen-Proxy als natürlicher Guard (dünne Räume lernen schlicht
nicht), und die Karte ist PER AGENT (nicht per Session) — sie aggregiert
über mehrere Räume, sodass die Rotation eines einzelnen Raums die Karte
nicht leert. **Kein eigenmächtiges Ändern der observed-store-Rotation**
(Plandirektive eingehalten).

---

## 2. Lern-Loop (Prototyp-Form)

`lib/self-voice.js` → `createSelfVoice({cfg, engine, stateDir,
observedStore, log})` mit:

- **`refreshFor(agentId, sessionKey)`**: liest `observedStore.readObserved(sk,
  200)`, filtert auf eigene Zeilen (lowercase-Namensmenge), bricht ab wenn
  `< MIN_VOLUME (30)`. Sonst: `engine.extractSelfVoice({transcript: eigeneZeilen,
  agentId})` → `prompt_block`. Ergebnis → Self-Voice-Bucket **per Agent**
  (stateByAgent-Mechanik von Plan 004, siehe Abschnitt Rendering).
- **Extract-Prompt (NEU, analog `buildExtractPrompt`)**: eigener Prompt in
  lib/local-prompts.js (exportiert aus buildExtractPrompt abgeleitet), aber
  „Analyze how THIS AGENT talks from its own past messages; return its
  distinctive voice (signature phrases, casing, rhythm, reaction patterns)
  STRICT JSON". Da die Quellzeilen eigene Outputs sind, ist die
  Zitat-Form der Vorlage (Gruppe) nicht nötig — eigene Zeilen dürfen als
  Grundlage für die eigene Stimme gelesen werden.
- **Refresh-Cadence**: `refreshMinutes` (default 60), NIEMALS im Hot Path —
  wie voice-card `spawnRefresh` (setTimeout, lib/voice-card.js:228-229).
- **Persistenz**: `state/self-voice/<agentId>.json`, version 1, 0600;
  0700-Verzeichnis; tmp+rename (Plan-004/mood-Konvention:
  lib/mood.js:125-131, lib/voice-card.js:169-181). Logs redacted
  (redactSessionKey).

---

## 3. Governance-Gates (der eigentliche Punkt)

- **Kein Auto-Render neuer/stärkerer Karte.** `refreshFor` schreibt in den
  `pending`-Bucket, NICHT in `active`. Bei einer stärkeren Karte wird nur ein
  **Diff-Preview geloggt** (alt vs neu, Zeilen-Zahl, redacted) und als
  `/soul voice`-Command-Ausgabe angeboten (index.js-Command-Pattern wie
  `/soul enhance`, lib/soul.js + index.js:182-194).
- **`/soul voice accept`**: übernimmt `pending → active` (schreibt activeCard
  + `.bak` — Enhance-Backup-Muster aus lib/soul.js:22-27).
- **Verwerfen**: `pending` bleibt unübernommen, nächster Diff überschreibt.
- **`/soul voice reset`**: löscht `active` kontrolliert (Stimme stirbt).
- **Never-mention-Clause im Render-Block** (wie Mood, lib/mood.js:120):
  Self-Voice ist interne Farbe, wird nie zitiert/erklärt/bewusst thematisiert
  — nur Konsistenz.
- **Governance-Prinzip** (über die Stimme hinaus, für ALLE künftigen
  Selbst-Lern-Features): Preview + Accept + Reset, niemals still übernehmen.

---

## 4. Rendering

**Reihenfolge in `buildPersonaPrompt`** (lib/persona.js:42-64): SOUL →
Self-Voice → voiceCard (Gruppe) → ANTI_TELL → Style-Stats. Bei aktiver
Self-Voice wird die Sektion VOR der Gruppen-Karte gerendert:

```
Your own voice (keep it consistent): <selfVoiceCard>
```

- Die Gruppen-Karte bleibt — sie beschreibt den RAUM, Self-Voice den AGENTEN.
- **Bucket-Design MIRROR von Plan 004** (lib/voice-card.js:33-57): Self-Voice
  nutzt dieselbe `stateByAgent`-Map-Mechanik (per-Agent-`{cache, counter}`),
  sodass dieselbe Karte in allen Räumen desselben Agents erscheint —
  Cross-Group-Konsistenz ist der Wunscheffekt („der Agent klingt überall
  gleich"). Sie ist NICHT per Session.
- **wrapUntrusted-Konvention**: einheitliches Wrapping wie alle
  Prompt-Blöcke (lib/persona.js:47, voice-card lib/voice-card.js:234).
  Gelernt aus eigenen Outputs ist die Self-Voice trustwürdig, aber die
  einheitliche Wrapping-Konvention wird beibehalten.
- **Kein Konflikt mit Plan 026**: Style-Stats EXKLUDIEREN inzwischen die
  eigenen Zeilen (lib/persona.js:49-56 filtert die Namensmenge heraus) —
  sie beschreiben den RAUM. Self-Voice wählt SELBST seine Zeilen aus
  (eigene Selektion) und liest aus dem observed-Store, nicht aus
  `transcriptPeekBySession`. Beide nutzen dieselbe Namensmenge, aber für
  gegensätzliche Zwecke; kein Konflikt.
- **Language-agnostisch (Plan 029)**: Die Self-Voice ist ein gelerntes
  Stil-Abstrakt aus ECHTEN Nachrichten (signature phrases, casing, rhythm),
  keine feste Sprache. Sie wird im Persona-Prompt in der Konversations-Sprache
  gerendert (Sprach-Packs rendern den Rahmen, der Inhalt ist sprachneutral).

---

## 5. Risiken & Mitigation

| Risiko | Mitigation |
|--------|-----------|
| **Overfit / Parrot-Loop** („signature phrases" → Wiederholung) | Caps (≤6 Phrasen im Prompt), Extract-Temperatur 0.2 (niedrig, aber nicht 0 — vermeidet starre Deterministik), Mindest-Volumen ≥30 eigene Zeilen, Owner-Gate vor jedem Übernehmen. |
| **Cross-Group-Inkonsistenz** | Karte PER AGENT (nicht per Session) → gleiche Stimme in allen Räumen. Das ist gewollt (nicht „zwei Agenten im selben Raum → gleiche Stimme"). |
| **Rotation verdrängt eigene Zeilen** | ≥30-Volumen-Proxy als Guard; Karte aggregiert über Räume. (Fund aus STOP-Prüfung, s. Quelle.) |
| **Drift im Laufe der Zeit** | Diff-Preview vor Übernahme; Reset gibt dem Owner kontrolliertes Löschen. |
| **Unbrauchbarer Extract-JSON** | Extract-Prompt-Design iterieren; unparsebarer Output → kein Learn (Fail-silent wie extractVoiceCard). |

---

## 6. Messung

- **Subjektiv (Owner-Review)**: Nach 3 Tagen Gruppenbetrieb prüfen, ob sich
  der Agent „wie derselbe" anfühlt — Stimme konsistent über Räume, ohne
  Parrot.
- **Objektiv**: Self-Voice soll im decide-ctx-Log sichtbar werden — Vorschlag:
  bei jedem Speak die aktuelle Self-Voice-Card-Länge (Zeichen) in das
  decide-Kontext-Log schreiben (analog moodEnergy, das im decide-Prompt
  auftaucht). So lässt sich messen, OB und WIE OFT die Karte den Prompt
  beeinflusst (Card-Länge je Speak als Indikator für aktivierte Stimme).

---

## Prototyp (gebaut hinter Config-Off) — Design-Ergebnis

Step 1 hält; der Prototyp wurde gebaut (Config-Off, kein Live-Wiring):

- `selfVoice.enabled: false` top-level in `lib/config.js` defaultConfig
  (+ NESTED_KEYS) und in `openclaw.plugin.json` configSchema.
- `lib/self-voice.js`: `createSelfVoice` mit
  - `refreshFor(agentId, sessionKey)` — Volumen-Guard, Extract über
    `engine.extractSelfVoice`, schreibt `pending`.
  - `snapshotFor(agentId)` — liefert `active` (null wenn disabled/leer),
    wie mood/threads `snapshotFor`.
  - `accept(agentId)` — `pending → active` (+ `.bak`).
  - `reset(agentId)` — `active` löschen.
  - Off-Vertrag: `selfVoice.enabled !== true` → keine Dateien, keine
    Renders, alle Methoden null/no-op.
  - State-Datei `state/self-voice/<agentId>.json`, version 1, 0600;
    0700-dir; tmp+rename; redacted Logs.
- `engine.extractSelfVoice` in lib/local-engine.js (analog extractVoiceCard)
  + `buildSelfVoiceExtractPrompt`/Render in lib/local-prompts.js (analog
  buildExtractPrompt/renderPromptBlock).
- Tests in `test/self-voice.test.js`: Off-Vertrag (zero files, zero renders),
  Extract/Preview/Accept/Reset-Loop mit Fake-LLM, Volumen-Guard. Muster
  voice-card.test.js / threads.test.js.
- KEIN Command-Wiring in index.js (Follow-up-Plan 033).

**Verify**: `npm test` → 1084 pass / 0 fail; Parity 77/77, Exit 0 (keine
neue Parity-Zeile).

---

## Follow-up-Plan-Empfehlung

**Plan 033** (nächster freier Slot nach den Wave-2-Plänen): Live-Bau —
`/soul voice`-Command-Wiring in index.js, Live-Flip von
`selfVoice.enabled: true` (Opt-in), decide-ctx-Log der Card-Länge je Speak.
Erbt Governance-Gates (Preview/Accept/Reset) aus diesem Report.
