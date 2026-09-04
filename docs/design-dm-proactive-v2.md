# Design: dm-proactive v2 — Proaktiv-Foundation nach dem Commitments-Ende

> **Plan 526** (Design, docs only) · Stand 2026-09-04 · Executor-Session opencode.
> **Bindend**: Kevin-Entscheidungen 2026-09-04 (Abschnitt 3) · OpenClaw 2026.8.1
> (`ea80657`) als API-Bindung — das Design baut NICHT auf 2026.8.2/9.1-Features
> (Update kommt später, vgl. `~/plans/README.md` Dependency notes Wave 93).
> Build-Folgepläne NUR aus Abschnitt 5 (Arbeitspakete) ableiten.

## 1. Ausgangslage (verifiziert 2026-09-04)

Drift-Check nach Plan-Vorgabe — alles bestätigt, mit zwei Anmerkungen:

- **Plan 518 DONE**: `~/.openclaw/commitments/` enthält nur
  `extractor-sessions/` — keine `commitments.json`. `loadCommitments()`
  (lib/dm-proactive.js:232-245) liefert daher seit 2026.8.1 IMMER `[]`
  (try/catch-Fallback), `reconcileCandidate()` (:247-272) matchet nie.
  Konsequenz: 7 Tage Shadow mit NULL Kandidaten, `dm-proactive.jsonl`
  existiert nicht, `state/dm-proactive-state.json` hat 2 Scopes mit
  `lastSentAt: 0` (nie live gesendet).
- **Plan 521 DONE**: `~/.openclaw/state/kevin-activity.json` existiert
  (49 Bytes, `{ "lastKnownKevinActivityAtMs": … }`, geschrieben
  2026-09-03 22:41) — DayFit-Input steht.
- **Config**: `openclaw.json:4815-4822` — `proactive.{enabled:true,
  shadow:true}` UND `dmProactive.{enabled:true, shadow:true}` (Plan-Anker
  :4814-4821 minimal verschoben, Inhalt unverändert). Scoped agents:
  `hori-wa` + `hori-wa-public-group-kletter` (openclaw.json:~4806-4809).
- **Zeilen-Drift vs Plan (2026-09-03)**: Commit `5b29c1a` ("refactor: extract
  shared proactive utils…") hat lib/dm-proactive.js von 468 auf **441**
  Zeilen verkleinert (Utils nach lib/proactive.js, jetzt **620** Zeilen) und
  die Tests wachsen lassen (`test/dm-proactive.test.js` **515**,
  `test/proactive.test.js` **571**). Alle Schlüsselstrukturen intakt,
  Anker verschoben — die Anker in diesem Doc sind die NEUEN, verifizierten.
- **Test-Baseline**: `npm test` = **707 pass / 0 fail** (141 Suites; Baseline
  vor jedem AP-Lauf wiederholen).

Wichtige Code-Anker (alle 2026-09-04 verifiziert):

| Konzept | Ort |
|---|---|
| Modul-Fabrik, State-/Log-/Store-Pfade | lib/dm-proactive.js:68-75 |
| Budget-Load/Save (0600, atomar, debounce) | :85-125 |
| Inbound-Bookkeeping (Antwort-Marker) | :181-195 |
| Outbound-Beobachtung + Live-Cancel-Pfad | :202-230 |
| Toter Store-Reader (ENTFÄLLT in v2) | :232-245 |
| Tote Reconciliation (ENTFÄLLT in v2) | :247-272 |
| Gate: budget/min-gap/care/quiet/double-text | :274-300 |
| Memory-Reference (anti-hallucination) | :304-327 |
| Render (LLM + Fallbacks) | :329-362 |
| handleCandidate (genau ein Log-Eintrag/Kandidat) | :371-434 |
| Hook-Registrierung message_received/message_sending | index.js:105,110 |
| isQuietHour (HOST-LOKAL — TZ-Problem, s. §2.2) | lib/proactive.js:133 |
| Config-Defaults dmProactive | lib/config.js:63-70 |
| Schema (strict, sync mit config.js) | openclaw.plugin.json:~111-125 |
| Aktivierungs-Checkliste (Operator) | lib/dm-proactive.js:26-33 |

## 2. Zielarchitektur (Plan-Step 1)

### 2.1 Kandidaten-Quelle — ENTSCHEIDUNG: Option A, Explicit Followup-Cron

**Kevin hat am 2026-09-04 entschieden (bindend, s. Abschnitt 3): Option A.**
Sie ist hier keine Option mehr, sondern die Architektur. B und C sind
verworfen (s. u.).

**Rollenverteilung**: hori-wa ist KANDIDATEN-PRODUZENT, dm-proactive ist
GATE + RENDERER. Kein dist-Patch, keine neue Plugin-Infrastruktur — exakt
die offizielle 2026.8.1-Empfehlung ("For reminders, create an explicit
automation").

**Fluss (5 Schritte):**

1. **Followup-Cron** (NEUER OpenClaw-Cron-Job mit EIGENER ID, 45-min-Intervall
   — NICHT der pausierte has-nudge-Job, s. Abschnitt 4): startet einen
   hori-wa-Agent-Turn. hori-wa identifiziert fällige Follow-ups selbst aus
   (a) dem lcm-Transkript der DM-Sessions (lossless-claw, was versprochen/
   verschoben/angesprochen wurde) und (b) dem gbrain-Äquivalent des alten
   `since --kind commitment` (Life-Chronicle-Ops `since`/`last-seen`,
   `~/gbrain/src/core/ops/chronicle.ts`; exakte Op-Kombination ist
   Build-Plan-Detail). Wenn nichts fällig ist: billiger Abbruch ohne Send.
2. **Envelope-Vertrag**: hori-wa schickt jeden Kandidaten als message-tool-Send
   mit strukturierter erster Zeile, die dm-proactive im `message_sending`-Hook
   parst und vor Zustellung stript:

   ```
   [[fu:{"id":"fu-<yyyymmdd>-<slug>","kind":"soft_followup|reminder|event|care_check_in","sensitivity":"normal|care","confidence":0.0-1.0,"dueWindow":{"earliestMs":n,"latestMs":n},"lastUserRefMs":n,"source":"followup-cron"}]]
   <von hori-wa formulierter Draft>
   ```

   Der Draft ist damit AGENT-AUTHORED (Persona/Voice vorhanden) — der LLM-
   Render in dm-proactive wird in v2 zur Veredelung statt zur Erfindung.
   `lastUserRefMs` = Kevin-Letztbezug auf das Thema (Epoch-ms), von hori-wa
   aus dem Transkript berechnet; für soft-tier PFLICHTFELD (s. §3 Q3).
   Anregungs-Quelle für Themen: social-memory `open_threads`
   (lib/local-prompts.js:114-116) — Alter aber immer aus dem Transkript
   (open_threads hat keine verlässlichen Timestamps).
3. **Gate-Check (Authoritativ, Schicht 2)**: `onMessageSending`
   (lib/dm-proactive.js:202-230) erkennt am Envelope, dass es ein
   Followup-Kandidat ist (normaler Agent-Text OHNE Envelope wird nie
   angefasst — fail-open, Konvention „DM errors fail open", Test #24).
   evaluateGate (:274-300) prüft: Budget/Caps, Min-Gap, Quiet-Hours
   (mit bestehender Deadline-Ausnahme < 2 h, :44), Care-Regeln
   (careBudgetPerDay 1 + harte 48-h-No-Reply-Regel, :45), Double-Text,
   DayFit (NEU, §2.2), Open-Loop-Alter (NEU, §3 Q3), Cadence byKind
   (NEU, §2.3), Idempotenz (Envelope-id gegen `sentIds`, s. u.).
4. **Shadow-Modus (v2-Semantik — bewusste Änderung ggü. Plan 412!)**:
   In v1 bedeutete shadow „nur loggen, dist-Fallback deliver". Den
   Fallback gibt es nicht mehr — der Cron-Send IST die Zustellung. Damit
   Kevins Q4-Kriterium („≥ 80 % beantwortet") messbar ist, liefert Shadow
   ECHT: **Shadow = Gating greift, Zustellung passiert als gerenderter/
   veredelter Draft, alles wird geloggt, kein Cancel des Originals —
   der Cron-Send selbst ist die Delivery.** Der Hook loggt Kandidat +
   Gate-Verdikts + Render-Preview und lässt den (bereits gegateten) Send
   durch. Im Shadow nie: cancel, rewrite, eigener subagent.run-Versand.
   Bekannte Limitation: Kevin antwortet auf den Cron-Draft, nicht auf die
   Render-Preview — Reply-Raten sind konservativ; Render-Qualität wird
   aus den Log-Previews bewertet (10-Item-Sample, Checkliste :26-33).
5. **Live-Modus** (`shadow:false`): wie der bestehende Live-Pfad — bei
   Gate-Pass `{ cancel: true }` (:228) und eigener Versand des gerenderten
   Drafts via `runtime.subagent.run` mit idempotencyKey (:418-427); bei
   Gate-Fail `{ cancel: true }` + Log — der Kandidat bleibt beim Cron für
   den nächsten Zyklus pending (bis dueWindow abläuft). Semantik-Änderung
   ggü. v1: In v1 ließ Gate-Fail den dist-Fallback deliver — in v2 gibt es
   keinen Fallback, Gate-Fail unterdrückt in Live.

**Idempotenz/Dedup**: `sentIds` (bounded, LRU ~512) im Plugin-State; gleiche
Envelope-id = Retry → Live: cancel + Log „duplicate"; Shadow: Log. Der Cron
wiederholt bewusst mit derselben id, bis delivered.

> **Amendment 2026-09-04 (Incident — Plan 536, bindend)**
>
> Live-Incident (Kevin erhielt denselben Kandidaten 3× mit ungestripptem
> Envelope, 07:46/09:47/10:04 Berlin) — drei Design-Korrekturen, die die
> Fluss-Beschreibung oben in drei Punkten übersteuern:
>
> 1. **Hook-ctx-Realität**: Der Produktions-`message_sending`-ctx enthält
>    KEIN `sessionKey` (OpenClaw 2026.8.1 `PluginHookMessageContext` =
>    `{channelId, accountId?, conversationId?}` — dist/plugin-sdk/src/plugins/
>    types.d.ts:2094; alle drei `runMessageSending`-Call-Sites übergeben
>    keins). Der DM-Scope wird deshalb aus dem EVENT abgeleitet: `to` +
>    `ctx.channelId`/`event.metadata.channel`, validiert gegen einen bekannten
>    State-Scope-Suffix (`agent:<a>:<channel>:direct:<to>`) oder bei exakt
>    einem konfigurierten Agent per Fallback. Kein Match/mehrdeutig → warn +
>    fail-open (nie raten). Gruppen-Targets werden nie abgeleitet (return).
>    Der frühere `ctx.sessionKey`-Pfad bleibt Erst-Wahl (falls irgendwo doch
>    gesetzt). Normal-Send-Fail-open (Parity #24) unverändert.
> 2. **Shadow supprimiert Gate-Fail/duplicate** (ersetzt „im Shadow nie:
>    cancel"): Shadow liefert NUR noch gate-pass Kandidaten aus (Envelope-
>    Strip + Log); Gate-Fail UND duplicate → `{cancel:true}` + Log. Grund:
>    „Gating greift" + Q4 „0 Gate-Verletzungen" (§2.4) verlangen Suppression —
>    ein Gate-Verletzer zu delivern spamt Kevin und verfälscht die Messgröße.
> 3. **Dedup-Zeile oben korrigiert**: `sentIds`-Hit cancelt in BEIDEN Modi
>    (Live + Shadow) + Log „duplicate". Grund: reine Idempotenz, keine
>    Messgröße; der amnesische Isolated-Cron regeneriert ids strukturell
>    (kann Delivery-State nicht sehen). Ein Kandidat = eine Delivery;
>    Retries sind Logs, keine Sends.

**Verdrahtung doppelt (Defense in Depth)**: Schicht 1 (Konvention): der
Cron-Prompt weist hori-wa an, vor dem Send das Verdikt zu prüfen — via
kleinem CLI (`bin/followup-gate.mjs check …`), das die SELBE Gate-Core-
Bibliothek importiert (AP a extrahiert `evaluateDmGate()` in ein shared
Modul; EINE Gate-Implementierung — keine Logik-Duplizierung, s. D1 in §4).
Schicht 2 (Autoritativ): der Hook cancelt in Live alles, was die Konvention
verletzt. Im Shadow macht Schicht 1 die „0 Gate-Verletzungen" messbar
(ein trotz Fail gesendeter Kandidat wäre die Verletzung und landet im Log).

**Verworfen (kurz, mit Grund):**

- **B — Eigenes Mini-Store** (followups.json gefüllt aus normalen Turns via
  Hook): mehr Magie, Konsistenz-Probleme (Turn-Kontext vs. Fälligkeit),
  und hori-wa müsste beim Schreiben schon wissen, was später fällig ist.
  Nur aktiv re-evaluieren, wenn A an Prompt-Grenzen stößt (z. B.
  Identifikationsqualität im Shadow-Log systematisch schlecht).
- **C — Nur Gates, keine Kandidaten**: minimal, verliert aber die
  „inferrte" Stärke komplett — dm-proactive würde zum QoS-Filter für die
  Cron-Lane degradiert. Mit A ist C als Teilmenge ohnehin abgedeckt.

### 2.2 DayFit — aktivitäts-bewusstes Timing

Input: `~/.openclaw/state/kevin-activity.json` →
`{ lastKnownKevinActivityAtMs }` (Plan 521, verifiziert existent).
Berechnung: `age = now − lastKnownKevinActivityAtMs`.

| Alter | DayFit | Wirkung |
|---|---|---|
| < 4 h | 1.0 (voll) | soft-tier erlaubt, normales Cap |
| 4–12 h | 0.5 (reduziert) | soft-tier-Cap halbiert: `ceil(inferredCapPerDay / 2)`; harte Reminder unberührt |
| > 12 h | — (pausiert) | soft-tier GEBLOCKT (Gate-Reason `dayfit-stale`); harte Reminder unberührt |
| Datei fehlt/unlesbar | — (unbekannt) | soft-tier GEBLOCKT (Reason `dayfit-unknown`, warn-once); harte Reminder passieren — lieber kein Ping ins Leere, aber Deadlines feuern |

- Harte Reminder (deadline/event) sind DayFit-unabhängig — sie MÜSSEN
  feuern; sie laufen durch dieselben anderen Gates (Kevin Q2).
- Implementierung: **im Plugin-Code** (evaluateGate, plus Helper z. B.
  `lib/dayfit.js`) — **NICHT als dist-Patch** (Plan-409-Lehre: dist-Patches
  sterben bei jedem Update; Kevin-Entscheidung 1: „KEIN dist-patch").
- Config-Felder NEU (in lib/config.js:63-70 UND openclaw.plugin.json:~111-125
  synchron — Schema ist strict): `dayFitReduceHours: 4`,
  `dayFitPauseHours: 12`.
- **TZ-PFLICHTARBEIT (gefunden, nicht neu erfunden)**: Der Host läuft auf
  **UTC** (verifiziert 2026-09-04, `timedatectl`), und `isQuietHour()`
  (lib/proactive.js:133) wertet HOST-LOKALE Stunden aus — Quiet-Hours
  „23:00–07:00" wirken real 01:00–09:00 Berlin. Exakt der Bug, den Plan 529
  als HAS-Must-Fix dokumentierte (UTC-Hostuhr statt Europe/Berlin). AP (b)
  muss Europe/Berlin explizit machen (Intl-API mit `timeZone`, kein
  Prozess-TZ-Dep). Gilt für Quiet-Hours UND DayFit-Tagesgrenze
  (`localDayKey()`, lib/proactive.js:86, heißt schon so und lügt).

### 2.3 Cadence-Verbrauch — Plugin-eigenes byKind-Bookkeeping

Empfehlung des Plans übernommen: **Plugin-eigen**, damit Gates nie von einer
externen Pipeline abhängen (Plan 527-Rollup LIEST, schreibt nie Gate-State).

State-Datei `state/dm-proactive-state.json` wird v2 — Schema-Kompatibilität
zu cadence-state.json v1 (Feldnamen/Semantik identisch, additive Felder):

```json
{
  "scopes": { "<agentId>::<sessionKey>": {
      "day": "…", "count": 0, "softCount": 0, "hardCount": 0,
      "careCount": 0, "lastSentAt": 0, "lastCareSentAt": 0,
      "lastReplyAtMs": 0, "lastSentCandidateId": null } },
  "byKind": { "<kind>": {
      "budgetMultiplier": 1.0, "sends": [{ "ts": 0, "scope": "…" }],
      "replyRate14d": 0.0, "ignoreStreak": 0, "paused": false } },
  "sentIds": ["fu-…"]
}
```

- `byKind{budgetMultiplier, sends, replyRate14d, ignoreStreak}` = exakt das
  cadence-state-v1-Feldset (vgl. Plan 525, `525-…design.md:53-54, 89-90`);
  `paused` additiv.
- **Dynamik** (Muster aus Plan 525 übernommen): `ignoreStreak ≥ 2` →
  budgetMultiplier 0.5; `ignoreStreak ≥ 4` → `paused: true` (soft-tier der
  Art ruht); Reply setzt Streak zurück. `replyRate14d` = Antworten (≤ 48 h
  nach Send, zugeschrieben) / Sends, rollierend 14 Tage, `sends` auf
  14-Tage-Fenster geprüft.
- **Reply-Attribution**: `onMessageReceived` (:181-195) erweitert — der
  letzte gesendete Kandidat pro Scope (`lastSentCandidateId`) gilt als
  beantwortet, wenn Inbound nach `lastSentAt` kommt. Bewusst simpel und
  bounded (eine Zuordnung pro Scope, kein Topic-Matching).
- Effektives soft-Cap pro Scope/Tag:
  `ceil(inferredCapPerDay × dayFitFaktor × budgetMultiplier(kind))` —
  `paused: true` blockt soft-tier der Art komplett (Reason `cadence-paused`).
- v1-State (nur `scopes`) lädt unverändert (Test!).

### 2.4 Shadow→Live-Kriterium

Von Kevin bestätigt (Q4) — unverändert wie designed:

1. **7 Tage** Shadow-Log nach Inkrafttreten von AP (a)–(e) + Cron-Lane.
2. **≥ 20 Kandidaten** geliefert (Gate-Pass-Deliveries; soft + hard — bei
   2 soft/Tag braucht es ~6 harte Reminder im Fenster, realistisch bei
   Deadlines/Events).
3. **≥ 80 % von Kevin beantwortet** (Reply ≤ 48 h, nach §2.3-Attribution).
4. **0 Gate-Verletzungen** (kein trotz Fail gelieferter Kandidat, kein
   Duplicate-Send, kein Quiet-Hours-Bruch — aus dem Log belegbar).
5. PlusRender: ≥ 10 Log-Previews fühlen sich menschlich an (Checkliste
   lib/dm-proactive.js:26-33).

**Live-Wechsel**: `openclaw.json` `dmProactive.shadow:false` (:4819-4822) +
Gateway-Restart; Verifikation: Log-Einträge mit `mode:"live"`, erste
Live-Sends beobachten. **Rollback**: Config-Flip zurück, < 1 Minute,
rein konfigurativ. **Danach**: 14-Tage-KPI-Review via Plan-527-v2-Rollup
(Schnittstelle: liest `state/dm-proactive.jsonl` + State v2; nur benennen,
kein Build hier).

**Kill-Switch (2 Hebel, unabhängig)**: `dmProactive.enabled:false` (Gates/
Renderer tot) UND Followup-Cron deaktivieren (Produzent tot). Beide müssen
im Runbook stehen.

### 2.5 PII/Privacy-Scope

- Follow-up-Inhalte (Drafts, Themen, Memory-Referenzen) leben NUR im
  Plugin-State: `state/` ist git-ignored (`.gitignore:2`), Dateien 0600,
  atomar geschrieben (lib/dm-proactive.js:97, 129, 136) — verifiziert.
- **Nie in dist**: Es gibt in v2 überhaupt KEINE dist-Patches mehr
  (Kevin-Entscheidung 1) — der Fail-Modus „PII in dist" ist strukturell
  ausgeschlossen.
- **Nie in Telegram-Kontrolltext**: Ops-/Kontroll-Nachrichten (Monitoring,
  Review-Reminders) tragen nur Aggregate (Counts, Rates, Gate-Reasons),
  nie Draft-Inhalte; Cron-Prompt muss das explizit untersagen.
- Log-Lines rotieren Session-Keys/IDs via `redactSessionKey()`
  (:396, 406, 427) — unverändert beibehalten.
- Repo ist PUBLIC (AGENTS.md): Fixtures/Kommentare nur mit offensichtlich
  fake Session-Keys (z. B. `agent:hori-wa:telegram:direct:<user>`).

## 3. Kevin-Entscheidungen (Decision Record, 2026-09-04 — bindend)

1. **Q1 Kandidaten-Quelle: OPTION A** — Explicit Followup-Cron statt
   Inferenz (45-min-Job als has-nudge-Nachfolger-KONZEPT); hori-wa
   identifiziert due follow-ups selbst aus lcm-Transkript + gbrain-
   Äquivalent und sendet via message-tool; dm-proactive wird GATE +
   RENDERER über den `message_sending`-Hook; KEIN dist-patch, keine neue
   Infra-Struktur (entspricht der offiziellen 2026.8.1-Empfehlung
   „explicit automation").
2. **Q2 Cap**: initial **max 2 inferrte Follow-ups/Tag (soft-tier)**;
   harte Reminder (deadline/event) vom Cap ausgenommen, laufen aber durch
   dieselben Gates; Cap konfigurierbar (Config-Feld
   `dmProactive.inferredCapPerDay`, Default 2). Als reine DoS-Rückfalle
   (NICHT Teil von Kevins Cap-Entscheidung): `hardCapPerDay` Default 4 —
   Build-Plan-Detail.
3. **Q3 Open Loops**: **7–14 Tage** seit letztem User-Bezug = soft-tier
   erlaubt, aber NUR bei vollem DayFit-Score (1.0); **> 14 Tage initial
   AUSGESCHLOSSEN** (Gate-Reason `open-loop-stale`) — Shadow-Daten können
   das revidieren (Review im Live-Kriterium, §2.4). ≤ 7 Tage: normales
   soft-tier. Messgröße: `lastUserRefMs` aus dem Envelope (§2.1).
4. **Q4 Live-Kriterium**: bestätigt wie designed — 7 Tage Shadow-Log mit
   ≥ 20 Kandidaten, davon ≥ 80 % von Kevin beantwortet, 0 Gate-Verletzungen
   → Live-Wechsel (`shadow:false`); danach 14-Tage-KPI-Review via
   Plan-527-v2-Rollup (Details §2.4).
5. **OpenClaw-Update später** — das Design baut NICHT auf 2026.8.2/9.1-
   Features; es bindet sich an die 2026.8.1-API (Hooks
   message_received/message_sending, `api.runtime.subagent.run`,
   Cron→Agent-Turn + message-tool).

## 4. Koordination mit Parallel-Plänen (gegegenzeichnet)

### Plan 529 — has-nudge-telegram-push bleibt PAUSIERT (gegegenzeichnet)

- `has-nudge-telegram-push` (Cron `e578dec0-90aa-4121-8375-bc0340a455dc`,
  enabled:false) bleibt für **HAS-Tasks** pausiert (HAS-DB ohne Writes seit
  16.08.). Revival-Kriterien und 4 Must-Fixes: `~/plans/README.md`
  „HAS-Nudge-Pause" (:4372 ff.) — **unverändert, entkoppelt von hier**.
- **Gegenzzeichnung**: Option A's Followup-Cron ist ein **NEUER Job mit
  EIGENER Cron-ID** — KEIN Revival des has-nudge-Jobs. Die README-Notiz
  „526 Option A setzt voraus, dass has-nudge re-aktiviert wird"
  (:4403, Wave-93-Dependency-Notes) ist durch Kevins Entscheidung vom
  2026-09-04 überholt und vom Folge-Build-Plan in der README zu korrigieren.
- Die 4 has-nudge-Must-Fixes (deliver-before-send, UTC-vs-Berlin-Quiet-
  Hours, per-task Cooldown, keine Mutation-Pfade) werden als **Konstruktions-
  Anforderungen für den NEUEN Job übernommen** (Lessons, nicht Revival-
  Bedingungen): Idempotenz + send-nach-Bestätigung (§2.1), Europe/Berlin
  explizit (§2.2 TZ-Pflichtarbeit), per-Thema-Cooldown via Open-Loop-Regeln
  (§3 Q3), Tailnet read-only für den Cron-Turn.
- Falls has-nudge später für HAS revived wird, existieren zwei Ping-Lanes
  → Koordinationsnotiz: HAS-Pushes laufen außerhalb der Plugin-Gates;
  gemeinsame Quiet-Hours/Cap-Politik dann über die gleiche
  Gate-Core-Bibliothek/CLI ziehen (D1), mindestens aber gleiche
  Schwellwerte.

### Plan 525 — Caps/Ledger für die CRON-Lane (Abgrenzung, D1)

- **D1 Gate-Ownership**: Die Gates für DM-proaktive Kandidaten liegen
  ausschließlich bei human-engine dm-proactive — EINE Gate-Instanz, EINE
  Implementierung (Gate-Core-Extraktion in AP a dient genau dem).
- **Keine doppelten Ping-Instanzen**: 525 baut Caps/Ledger für SEINE
  Cron-Lane-Sends (Robot-Jobs, Jitter, Varianten). Followup-Cron-Kandidaten
  werden NICHT von 525 gegated — Diskriminator ist der Envelope-Vertrag
  (§2.1): nur `[[fu:…]]`-Sends passieren die dm-proactive-Gates; 525-Lane-
  Sends tragen keinen Envelope und werden vom Hook nie angefasst.
- **Ledger vs. Plugin-State**: 525s Ledger schreibt NIE in
  `dm-proactive-state.json`; `byKind` ist plugin-intern (§2.3). Gemeinsam
  ist nur das Muster (cadence-state-v1-Schema) und das Signal
  `kevin-activity.json` (read-only, Plan 521). Aggregation NUR lesend über
  Plan-527-Rollup — keine dualen Writer auf denselben Feldern. Nutzt 525
  später DayFit in seiner Lane: gleiche Schwellwerte (4/12 h), getrennte
  Implementierung oder Import der Plugin-Lib — kein shared mutable State.

### Plan 527 — KPI-Rollup (nur Schnittstelle)

Plan-527-v2-Rollup liest `state/dm-proactive.jsonl` (Entry-Shape § AP d)
und `dm-proactive-state.json` v2 für den 14-Tage-Review nach Live-Wechsel
(§2.4). Kein Schreibzugriff auf Gate-State. Build dort, nicht hier.

## 5. Umbau-Entwurf: Arbeitspakete (Plan-Step 3)

Reihenfolge: **(a) → (b) ∥ (c) ∥ (d) → (e) → [Shadow-Fenster 7 Tage] → (f)**.
(b)/(c)/(d) sind nach (a) unabhängig voneinander parallelisierbar;
(e) konsolidiert und accompanies jede Phase (Tests laufen mit, finaler
Sweep am Ende). Build-Pläne NUR nach diesem Design anlegen (Plan-Wartung).

| # | Paket | Aufwand | Hängt ab an | Verify-Idee |
|---|---|---|---|---|
| **a** | **Source-Adapter**: `loadCommitments` (:232-245) + `reconcileCandidate` (:247-272) entfernen; Envelope-Parser (`[[fu:{…}]]`, strippen vor Zustellung); Gate-Core `evaluateDmGate()` in shared Modul extrahieren; CLI `bin/followup-gate.mjs check` (Schicht-1-Verdikte für den Cron); `sentIds`-Idempotenz im State; Hook erkennt nur Envelope-Sends, normaler Agent-Text fail-open | **M** | — (Fundament) | Unit: Envelope valid/invalid/malformed (malformed → warn + pass-through, KEIN cancel — non-envelope könnte normale Antwort sein); CLI gibt Verdikt-JSON; Hook-Test: Envelope-Send in DM-Scope → Gate läuft, Normal-Send → unberührt; v1-State lädt |
| **b** | **DayFit**: Helper (kevin-activity.json-Read, mtime-gecacht) + evaluateGate-Integration (Reasons `dayfit-reduced/stale/unknown`); **TZ-Fix Europe/Berlin für Quiet-Hours + localDayKey** (§2.2); Config-Felder `dayFitReduceHours/dayFitPauseHours` (Schema-Sync!) | **S** | (a) Gate-Core | Tests: Alter 1 h/6 h/20 h/Datei fehlt/signal > 36 h stale → soft-tier blockt/statt halbiert; harte Reminder unberührt; `localDayKey`/`isQuietHour` in Europe/Berlin korrekt (23:00 Berlin = 21:00 UTC im Test fixiert); schema-strict-Check |
| **c** | **Cadence-State intern**: State v2 (§2.3-Schema: byKind + softCount/hardCount + lastSentCandidateId + sentIds); Reply-Attribution in onMessageReceived; ignoreStreak→budgetMultiplier/paused-Dynamik; 14-Tage-Prune | **M** | (a) | Tests: v1-State lädt unverändert (scopes); Reply aktualisiert replyRate14d + Streak-Reset; ignoreStreak ≥ 4 → `cadence-paused` blockt soft-tier, harte Reminder unberührt; Prune hält 14-Tage-Fenster |
| **d** | **Shadow-Log-Rotation**: dm-proactive.jsonl-Einträge mit `day`-Key, `source:"followup-cron"`, `candidateId`, `renderPreview` (Shadow) vs `render` (Live), `outcome:{repliedWithin48h}`-Backfill bei Inbound; 14-Tage-Retention-Prune beim Append (4-MB-Byte-Cap :46 als Rückfalle bleibt) | **S** | (a) | Tests: 20 Tage alte Einträge werden geprunt, Review-Fenster (7/14 Tage) bleibt vollständig; Outcome-Backfill setzt replied-Flag; ein Eintrag pro Kandidat (Invariant :364-370) |
| **e** | **Test-Update der 515-Zeilen-Tests** (test/dm-proactive.test.js): Mock-Store-Fixtures → Envelope-Fixtures; alle Gate-Tests behalten (budget/min-gap/quiet/care/double-text — evaluateGate bleibt); NEU: DayFit-Bänder, Open-Loop 7/14/>14, soft/hard-Cap-Exemption, Cadence-Paused, Idempotenz, malformed-Envelope-Pass-Through, Shadow-v2-Semantik (kein Cancel in Shadow; Live cancelt Gate-Fail); Parity-Matrix #37–#40 auf v2-Semantik umschreiben („shadow pass-through raw/live cancel+render"), 40/40 halten | **M–L** (größtes Paket) | (a)–(d) | `npm test` grün über Baseline 707 pass/0 fail hinaus (Zielwert notieren); `node test/parity-matrix.mjs --check` 40/40; AGENTS.md-Zeile nur bei struktureller Änderung anfassen |
| **f** | **Live-Gate**: Aktivierungs-Checkliste (:26-33) aktualisieren auf Q4-Kriterium; Runbook Config-Flip (:4819-4822) + Restart + Log-Verifikation (`mode:"live"`) + Rollback + 2-Hebel-Kill-Switch; 14-Tage-KPI-Review anstoßen (527-v2-Interface) | **S** | (a)–(e) + 7-Tage-Shadow-Fenster + Kevin-Review | Dry-Run auf Test-Config (shadow:false lokal, Hook-Feuer beobachtet); jq-Sweep über Log nach `mode:"live"`; Rollback-Timing < 1 min geübt |

**Cron-Job selbst** (Neuanlage mit eigener ID, 45 min, hori-wa-Turn,
Prompt: Identifikation + Envelope + Schicht-1-Gate-Check + billiger
Abbruch) ist Bestandteil des Build-Folgeplans zu AP (a) — Plan 526 Scope
ließ Cron-Anlage bewusst raus; der Vertrag steht in §2.1.

## 6. Upstream-Beobachtung & Update-Bindung

- Bindung an 2026.8.1 (`ea80657`): Hooks `message_received`/
  `message_sending`, `api.runtime.subagent.run`, Cron→Agent-Turn +
  message-tool. KEIN Gebrauch von 2026.8.2/9.1-Features (Update später,
  nach Plan 519, s. README Dependency notes).
- Scout-Skill beobachtet die Releases. Bringt Upstream ein
  „follow-ups"-/commitments-artiges Subsystem zurück (2026.8.1 hatte
  „Retire inferred follow-up commitments" entfernt): Design re-evaluieren —
  Eigenbau vs. upstream. Switch-Kosten sind bewusst klein gehalten: Der
  Kandidaten-Produzent (Cron+Envelope) ist vom Gate/Renderer entkoppelt —
  ein Upstream-Comeback würde NUR die Produzentenseite ersetzen, Gates/
  Renderer/State blieben. Das ist der Hauptgrund, warum AP (a) als
  Adapter (nicht als Verschmelzung) gebaut wird.

## 7. Offene Punkte für Build-Pläne

1. Envelope-JSON-Schema versionieren (Toleranz bei unbekannten Feldern:
   ignorieren, nicht ablehnen) + Fehlverhalten bei parse-broken Envelope
   dokumentieren (pass-through + warn, §2.1 — bewusst fail-open).
2. Cron-Prompt-Design: Identifikationsheuristik aus lcm-Transkript +
   gbrain-Chronicle-Ops; Selbstbeschränkung (≤ softCap); billiger
   Abbruch, wenn nichts fällig (32 Läufe/Tag — LLM-Kosten im Ops-Blick
   behalten; ggf. Intervall-Verlängerung als spätere Config, NICHT gegen
   Kevins 45-min-Entscheidung ändern ohne Rückfrage).
3. `hardCapPerDay` Default 4 (DoS-Rückfalle) — von Kevin abnehmen lassen.
4. gbrain-Op-Kombination (chronicle `since` vs. Memory-Search) für das
   „since --kind commitment"-Äquivalent.
5. Render in Live: Cron-Draft ist schon agent-authored — Render-Pass
   dünnen (Veredelung statt Erfindung, bestehende Fallbacks :331/:356/:360
   behalten) und Memory-Reference-Pflicht lockern?
6. Scope des Cron: nur `hori-wa` (DM-Lane) — das Kletter-Group-Agent
   braucht die Lane nicht (openclaw.json:~4806-4809 both scoped, Hook
   prüft isScopedAgent ohnehin, :207-208).
7. Kevin-Kontrollkommandos („hör auf, mich zu X zu nerven" → topic-pause)
   — Plan-525-Muster; hier nur als späterer Folgeplan notiert.
8. README-Korrektur Plan 529-Notiz (:4403) mit dem Cron-Build-Plan
   einreichen („NEUER Job, kein Revival", §4).
