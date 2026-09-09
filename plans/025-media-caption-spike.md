# Plan 025: Media-Caption Spike — Was weiß der Agent über Fotos/Voice-Notes? (Design/Spike, KEIN Build)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`. Das Ergebnis dieses Plans ist ein REPORT
> (`plans/025-media-caption-spike-report.md`), KEIN Produktionscode.
>
> **Drift check (run first)**: `git -C ~/human-engine diff --stat c4e148b..HEAD -- lib/gate.js docs/`
> On mismatch mit dem Excerpt: STOP condition.

## Status

- **Priority**: P2
- **Effort**: M (Untersuchung, kein Build)
- **Risk**: LOW (read-only + ein dokumentierter Prototyp-Versuch in einem Wegwerf-Branch/Worktree)
- **Depends on**: none
- **Category**: direction (spike)
- **Planned at**: commit `c4e148b`, 2026-09-09

## Why this matters

Ein großer Teil echten WhatsApp-Gruppenlebens ist Medien: Fotos von
Begehungen, Memes, Voice-Notes. Der Gate entscheidet über
Medien-Nachrichten anhand inhaltsleerer Marker (`[image]`,
`[voice message]`), und der Decide-Prompt sagt „React only when the media
clearly concerns the group" — ohne dass der Entscheider den Inhalt kennt.
Bevor wir irgendetwas bauen (Vision-Captions? Transkripte? Host-Delegation?
Kostet jede Media-Nachricht einen LLM-Call?), müssen drei Fragen geklärt
sein: (1) Was liefert der Host an Media-Metadaten/Captions im Hook-ctx?
(2) Sieht der HAUPT-Agenten-Turn die Medien tatsächlich natativ (Vision)?
Wenn ja ist der Gap rein Gate-seitig. (3) Wie viele Media-Nachrichten sind
real im Live-Verkehr? Der Spike liefert die Entscheidungsgrundlage.

## Current state

`lib/gate.js:26-35` (bei `c4e148b`):

```js
export function detectInboundMedia(event) {
  const facts = event?.media || event?.originalMedia || [];
  if (facts.length === 0) return null;
  const first = facts[0] || {};
  const kind = first.kind || "";
  const hasMedia = true;
  const mediaKind = kind in SDK_KIND_TO_PLACEHOLDER ? kind : "unknown";
  const marker = SDK_KIND_TO_PLACEHOLDER[mediaKind] || "[media]";
  return { hasMedia, mediaKind, marker };
}
```

gate.js:115-117: bei Media-only ohne Text → `current.text = media.marker`.
Decide-Prompt (local-prompts.js:154): „Media messages (photos, voice notes)
appear as [image]/[voice message] markers. React only when the media
clearly concerns the group…". `estimateReadMs` (local-engine.js:98-112)
addiert pauschal 1500 ms bei Media im Transcript.

`docs/media-findings.md` existiert (Plan 510-Kontext) — als Startpunkt
lesen. Der Host liefert `PluginHookMessageReceivedEvent` mit optionalen
media-Fakten; ob es Captions/mediaUrl gibt, ist über die SDK-Typen zu
verifizieren (node_modules/openclaw SDK types.d.ts — Worktree-Setup:
test/helpers/ensure-plugin-sdk-shim.mjs).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Tests (nach Report-Only unverändert) | `npm test` | all pass, 0 fail |

## Scope

**In scope**:
- Recherche: SDK-Typen (`media`/`originalMedia`-Fakten-Shape),
  Hook-ctx-Felder (message_received), docs/media-findings.md,
  observed-store-Live-Daten (nur Struktur/Häufigkeit, PII-safe zählen)
- Prototyp (optional, Wegwerf): ein Zweig ohne Merge — Caption-Feld, falls
  vorhanden, in die Transcript-Zeile
- `plans/025-media-caption-spike-report.md` (NEU — Deliverable)

**Out of scope**:
- Jeder Produktions-Commit auf main; jede Config-Änderung live
- Vision-/Transkriptions-LLM-Pipelines bauen
- TTS-Ausgabe (Plan 548b, existiert)

## Git workflow

- Kein Merge; falls Prototyp: Branch `spike/025-media-caption` ohne PR.
- Deliverable ist der Report.

## Steps

### Step 1: SDK-Inventur (read-only)

1. SDK-Typen des Hosts finden (node_modules/openclaw bzw. die
   plugin-sdk-Aliase — shim über test/helpers/ensure-plugin-sdk-shim.mjs
   zeigt den Weg). `PluginHookMessageReceivedEvent`-Shape: welche Felder
   hat `event.media[i]` (kind, url, caption, …)? Hat der ctx
   `mediaUrl`/`caption`/`transcription`?
2. docs/media-findings.md lesen und mit dem aktuellen Code abgleichen
   (Stand Plan 510 vs. heute).
3. Frage (2) beantworten: Feuert der Haupt-Agenten-Turn (nach speak) mit
   dem Original-Media-Payload (Vision-fähig beim Host-Modell) — prüfbar
   über SDK-Doku/Typen von `before_agent_reply`/Agent-Run-Media-Handling;
   im Zweifel: als offene Frage im Report markieren + Live-Test-Vorschlag.

**Verify**: Report-Abschnitt 1 existiert mit Datei:line-Belegen.

### Step 2: Live-Verkehr messen (PII-safe)

Zähle in `state/observed/*.jsonl` (NICHT lesen-inhaltlich, NUR
Strukturmetriken): Anteil Zeilen mit `[image]`/`[voice message]`/etc. an
allen Zeilen, absolut pro Session. KEINE Inhalte in den Report kopieren —
nur Zähler. (Bash/Node one-liner mit awk-ähnlicher Logik; state/ ist
gitignored und bleibt unberührt.)

**Verify**: Report-Abschnitt 2: „N Medien-Zeilen von M (X %)" pro Session.

### Step 3: Entscheidungsmatrix + kleinste-Änderung-Vorschlag

Report-Abschnitt 3:

| Fund | Kleinste sinnvolle Änderung |
|------|-----------------------------|
| Caption im Event vorhanden | Caption in die Transcript-Zeile (Marker → „[image: caption]") — S-effort, Plan folgt |
| Kein Caption, Agent-Turn sieht Media nativ | Nur Decide-Prompt schärfen („the group will see the photo; judge by thread context") + estimateReadMs nach kind gewichten — S-effort |
| Beides nein | Optionen: Vision-Spike via eigener LLM-Beschreibung (M/L, Kosten-Note) — bewusst NICHT bauen; Empfehlung dokumentieren |
| Transkripte vom Host (voice) | Analog Caption-Pfad |

Kosten-Note je Option (Extra-LLM-Calls/Message), Risiko (Latenz im
Decide-Pfad), Empfehlung mit Begründung. Am Ende: konkreter Entwurf des
FOLOW-UP-Plans (Nummerierung: der nächste freie Plans-Slot).

**Verify**: Report komplett; `npm test` unverändert grün.

## Test plan

Keiner (Spike). `npm test` läuft nach jedem Arbeitsschritt ohne Diff auf
lib/.

## Done criteria

- [ ] `plans/025-media-caption-spike-report.md` existiert mit Abschnitten
      1 (SDK-Inventur, file:line-Belege), 2 (Media-Anteil, PII-safe),
      3 (Matrix + Empfehlung + Follow-up-Plan-Entwurf)
- [ ] KEIN Diff auf lib/ in main-Worktree (`git status` sauber außer dem Report)
- [ ] `plans/README.md` Status-Row aktualisiert (DONE = Report geliefert)

## STOP conditions

- SDK-Typen sind im Worktree nicht auffindbar (shim unvollständig) →
  Report mit dem Gap + Live-Verifikations-Vorschlag statt Rätselraten.
- state/observed-Struktur weicht ab (keine jsonl-Zeilen) → Abschnitt 2
  als „nicht messbar" dokumentieren, nicht umbiegen.

## Maintenance notes

- Der Report ist die Grundlage für den Media-Follow-up-Plan — Nummer im
  Report vermerken, damit die nächste Welle ihn direkt aufnimmt.
- Falls der Host zwischenzeitlich Captions/Transkripte nachliefert
  (OpenClaw-Update — scout-Check), Abschnitt 1 revisitieren.
