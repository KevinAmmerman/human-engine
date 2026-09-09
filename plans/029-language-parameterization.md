# Plan 029: Sprach-Parameterisierung — Deutsch aus den Prompts/Regexes in Konfiguration heben

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git -C ~/human-engine diff --stat c4e148b..HEAD -- lib/local-prompts.js lib/mood.js lib/proactive.js lib/config.js openclaw.plugin.json test/local-prompts.test.js`
> On mismatch mit den "Current state" excerpts: STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW-MED (nur `de`-Pack live wirksam; Nicht-de-Gruppen sind Neuland — proaktive Trigger laufen für nicht-de auf reduziertem Modus, bewusst dokumentiert)
- **Depends on**: none (nach 024 ideal, um die Split/Regenerate-Prompts nur einmal anzufassen — kein Hard-Dep)
- **Category**: direction / tech-debt
- **Planned at**: commit `c4e148b`, 2026-09-09

## Why this matters

Das Repo ist public und multi-tenant (Welle 001–008: beliebige Agenten/Gruppen
deklarativ), aber die Gesprächsschicht ist hart auf Deutsch verdrahtet:
`(for this group: German)` im Split-Prompt, „German chat message" im
Regenerate, „schreibe auf Deutsch" im DM-Render, „(vor Xh)"-Alterslabels,
deutsche Gefühls-Wörter im Mood-Appraisal und deutsche Wortlisten
(QUESTION_WORD_RE, PROMISE_RE, CELEBRATION_WORD_RE, STOPWORDS) in den
proaktiven Triggern. Jede nicht-deutsche Gruppe bekommt falsches Verhalten
(deutsche Split-Anweisung, nie feuernde Trigger). Fix: ein per-Agent
-auflösbares `language` (default `"de"` — Live-Gruppen unverändert) mit
einem Sprach-Pack, in dem die deutschen Literale landen.

## Current state

Hartkodierte Deutsch-Literale (bei `c4e148b`):

- `lib/local-prompts.js:17,20` — `"(vor " + hours + "h)"` / `"(vor " + days + "d)"` (formatAge)
- `lib/local-prompts.js:232` — `"LANGUAGE: Write in the dominant language of the context lines (for this group: German). Never answer in English unless the draft itself is in English."`
- `lib/local-prompts.js:204` — `"Write ONLY the actual reply you would send now: a short, natural German chat message (1-2 lines), matching the group's tone."`
- `lib/local-prompts.js:262-263` (buildDmRenderPrompt) — `"Rewrite the suggested message so it reads like a real human DM"` + `"Rules: write in German; …"` (deutsche Konventionen sind semantisch verwoben — vorsichtig parametrisieren, Bedeutung erhalten)
- `lib/mood.js:95-105` — Appraisal-Prompt + `VALENCE_LABELS`/`ENERGY_LABELS` deutsch (Z. 4-18)
- `lib/proactive.js:27-47` — QUESTION_WORD_RE, PROMISE_RE, CELEBRATION_WORD_RE, STOPWORDS deutsch

Config-Overlay existiert: `resolveAgentConfig` (config.js:127-140) — ein
`language`-Key pro agentProfile funktioniert sofort (String-Override).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Unit | `node --test test/local-prompts.test.js test/mood.test.js test/proactive.test.js test/config.test.js` | all pass |
| Tests | `npm test` | all pass, 0 fail |
| Parity | `node test/parity-matrix.mjs --check` | fully covered, exit 0 |

## Scope

**In scope**:
- `lib/local-prompts.js` (languagePack + formatAge/buildSplitPrompt/
  buildRegeneratePrompt/buildDmRenderPrompt parametrisieren)
- `lib/mood.js` (Labels + Appraisal-Prompt über Pack; Pack minimal:
  Labels + Gefühls-Wort-Zeile)
- `lib/proactive.js` (Wortlisten hinter Pack; Nicht-de-Fallback dokumentiert)
- `lib/config.js` + `openclaw.plugin.json` (`language: "de"`, agent-overlay-fähig)
- Tests

**Out of scope**:
- NEUE Sprach-Packs schreiben (nur `de`; Struktur erlaubt später mehr —
  ein leeres `en`-Skeleton als Beweis der Parametrisierbarkeit ist OK)
- MESSAGE_TEMPLATES (proactive) — deutsche Templates bleiben de-only;
  nicht-de + proactive → dokumentierter reduzierter Modus (siehe Step 3)
- Splits-Spracherkennung aus dem Transcript („dominant language" — die
  Zeile bleibt, nur der Hinweisteil parametrisiert)

## Git workflow

- Branch: `advisor/029-language-param`
- 2–3 Commits (Pack+Config, Prompts, proactive/mood); Stil `plan 029: …`

## Steps

### Step 1: Config + Pack

1. `config.js` defaultConfig: `language: "de"` (top-level, per-profile
   überlagerbar — String, kein NESTED_KEY). Schema-Property.
2. `lib/local-prompts.js`:
   ```js
   export const LANGUAGE_PACKS = {
     de: {
       code: "de", label: "German", replyLanguageHint: "(for this group: German)",
       ageHours: (h) => `(vor ${h}h)`, ageDays: (d) => `(vor ${d}d)`,
       regenStyle: "a short, natural German chat message (1-2 lines)",
       dmStyle: "write in German; short (1-3 sentences)",
       moodFeelWords: "Nutze nur einfache Gefühlswörter (gut/schlecht, ruhig/aufgeladen, will/fühlt/passiert).",
     },
   };
   export function languagePack(code) { return LANGUAGE_PACKS[code] || LANGUAGE_PACKS.de; }
   ```
   (Feldnamen final im Code sinnvoll wählen; de-Strings SINNGETREU aus den
   bestehenden Literalen übernehmen — Wortlaut der Live-Prompts bleibt
   für de byte-identisch, das ist der Rückwärtsvertrag!)

**Verify**: `node --test test/local-prompts.test.js` → pass (Bestehende
Assertions gegen de-Strings bleiben grün — Identitäts-Beweis).

### Step 2: Prompt-Builder parametrisieren

1. `formatAge(ts, nowMs, lang)` — Age-Labels aus Pack (Param optional,
   default "de"; alle bestehenden Caller unverändert kompatibel; render-
  TranscriptLine reicht lang durch — die Aufrufe in buildDecidePrompt/
  buildSplitPrompt stammen aus gate/naturalize und haben den agentCfg-
  language-Zugriff dort: als Parameter einfließen lassen).
2. buildSplitPrompt/buildRegeneratePrompt/buildDmRenderPrompt: `language`
  -Param (vom Caller aus resolveAgentConfig(cfg).language) — ersetzt die
   Hart-Strings durch Pack-Felder. Caller (local-engine.js respond/
  regenerateReply, dm-proactive render) reichen cfg.language durch
  (local-engine hat cfg im Scope).
3. mood.js: buildAppraisalPrompt + VALENCE/ENERGY_LABELS über Pack
  (Labels nur Display/Kontext — die numerischen Achsen bleiben; Pack
  ergänzt moodFeelWords).

**Verify**: `node --test test/local-prompts.test.js test/mood.test.js` → pass.

### Step 3: Proaktive Wortlisten

1. In `lib/proactive.js`: die deutschen Regexes/Sets in
   `TRIGGER_WORDPACKS.de` (Shape wie oben) heben; Frage-Wörter, Promise-
   Phrasen, Celebration-Wörter, STOPWORDS.
2. Nicht-de (Pack fehlt): `unansweredQuestion` läuft im reduzierten Modus
   (trailing „?" reicht), Promise/Celebration-Trigger deaktiviert +
   EIN Warn-Log pro Scope (`language pack <code> has no proactive word
   lists — reduced trigger mode`). Kein still-Fail.
3. Templates bleiben wie sie sind (de) — der reduzierte Modus sendet
   halt weniger proaktiv; dokumentiert im Plan-Review.

**Verify**: `node --test test/proactive.test.js` → pass (de-Cases grün;
reduzierter Modus: 1 Case mit Fake-Pack-Code).

### Step 4: Tests + Parity

1. de-Identität: alle bestehenden Prompt-Assertions grün OHNE Anpassung
   (das IST der Rückwärtsvertrag-Beweis; wenn eine Assertion angepasst
   werden muss, war der String nicht sinngetreu gehoben → korrigieren).
2. Skeleton-Pack `en` (nur Struktur, keine proactive-Listen): formatAge
   `(3h ago)/(2d ago)`, split hint `(for this group: English)` — 2–3
   Tests als Parametrisierbarkeits-Beweis.
3. agentProfiles-Overlay: Profil mit `language: "en"` → gate/naturalize
   nutzen en-Pack (Integrationstest mit resolveAgentConfigForSession).
4. Parity-Row: „prompts/labels/trigger-wordlists resolve via language
  packs; de is byte-identical default; non-de groups run documented
  reduced proactive mode".

**Verify**: `npm test` → all pass; Parity fully covered.

## Test plan

Siehe Step 4. Anker: local-prompts.test.js (Identität) + config-Overlay-Tests.

## Done criteria

- [ ] `rg -n "LANGUAGE_PACKS" lib/local-prompts.js` → Treffer
- [ ] `rg -n "for this group: German" lib/local-prompts.js` → nur noch im de-Pack
- [ ] `rg -n "QUESTION_WORD_RE" lib/proactive.js` → aus Pack bezogen (kein hartes Regex-Literal mehr außerhalb des Packs)
- [ ] `npm test` exit 0; Parity fully covered
- [ ] `plans/README.md` Status-Row aktualisiert

## STOP conditions

- Ein de-Prompt-String lässt sich nicht sinngetreu ins Pack heben (z.B.
  weil der deutsche Wortlaut mit Regeln verwoben ist) → diese eine Stelle
  als TODO im Code + Report, NICHT halb übersetzen.
- formatAge-Signaturänderung bricht >3 externe Test-Call-Sites → optionalen
  Param defaulten und Caller-Updates minimal halten; wenn unvermeidbar
  groß → Report.

## Maintenance notes

- Neue Sprachen = neuer Pack-Eintrag + ggf. proactive-Wortlisten —
  Struktur ist der Vertrag; die ersten 2–3 Packs werden Übersetzungs-Arbeit
  des Owners sein.
- Der DM-Render-Stil (deutsche Understatement-Formulierungen) ist Teil des
  de-Packs — für en wird eine eigene Stil-Zeile nötig (Semantik ≠
  Wort-für-Wort): bewusst dem Pack überlassen.
- Live-Gruppen: `language` nicht setzen = de = byte-identisch. Kein
  Operator-Schritt nötig.
