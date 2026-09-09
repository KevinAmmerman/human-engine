# Plan 020: Social-Memory-Schema v2 wiring — relationship, open_threads, emotional_state live schalten (hinter Flag)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git -C ~/human-engine diff --stat c4e148b..HEAD -- lib/social-memory.js lib/local-prompts.js lib/config.js openclaw.plugin.json test/social-memory.test.js`
> On mismatch mit den "Current state" excerpts: STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (neue Extract-Felder erhöhen Prompt/Output; Caps + extract-only-Regeln sind die Guardrails; Rollout hinter default-off-Flag)
- **Depends on**: 019 (Person-Store — die Felder landen in Personen-Profile; ohne 019 funktionieren sie trotzdem pro Session, aber 019 zuerst vermeidet Doppel-Migration)
- **Category**: direction
- **Planned at**: commit `c4e148b`, 2026-09-09

## Why this matters

Das v1-Schema (facts/preferences/situation) macht Memory zu einem CRM-Dump:
Teasing-Stil, Insider/Running Jokes, offene Threads und emotionale Kontexte
— das, was eine Person in einem Gruppenchat „menschlich bekannt" macht —
sind unrepräsentierbar. Das V2-Design (wiki/design/social-memory-v2.md,
Owner-reviewed, „approved pending operator review") existiert komplett: der
V2-Extract-Prompt ist bereits geschrieben und getestet
(`buildMemoryExtractPromptV2`, local-prompts.js:111-130) — aber tot, weil
social-memory.js nur die v1 importiert und kein `schemaV2`-Flag existiert.
Dieser Plan wired beides. Design-Anpassungen aus Plan 019: Self-Exclusion
erfolgt zusätzlich defensiv im Merge (nicht nur per Prompt).

## Current state

`lib/social-memory.js:4`:

```js
import { buildMemoryExtractPrompt } from "./local-prompts.js";
```

V2-Prompt existiert UNGENUTZT (`lib/local-prompts.js:111-130`):

```js
export function buildMemoryExtractPromptV2({ existingProfile, newMessages, agentName }) {
  const systemPrompt = [
    "You maintain person-centric memory for a group chat. … return the UPDATED profile as STRICT JSON:",
    '{ "people": { "<name>": { "facts": [...], "preferences": [...], "situation": "...", "relationship": "...", "open_threads": [{ "topic": "...", "lastExchange": "...", "whoOwesWhat": "..." }], "emotional_state": "..." } } }',
    `Rules: … drop raw smalltalk; never invent; compact duplicates; …`,
    `Field caps: facts ≤ 12, preferences ≤ 6, relationship 1-2 sentences (only what is observed in dialogue, never synthesized), open_threads ≤ 3 with whoOwesWhat naming only the parties involved, emotional_state ≤ 1 short-lived sentence with updatedAtTs.`,
    `Self-exclusion: the assistant's own name (${agentName || "the assistant"}) and its aliases are NEVER person entries.`,
    UNTRUSTED_DIRECTIVE,
  ].join("\n");
  /* userMessage wie v1 */
}
```

Design-Vorgaben (social-memory-v2.md, wörtlich relevant): facts Cap 12,
preferences Cap 6, relationship 1-2 Sätze extract-only, open_threads ≤ 3,
emotional_state kurzlebig mit `updatedAtTs`, „Hallucinierte Beziehungen:
relationship ist extract-only aus beobachtetem Dialog, nie synthetisiert",
PII: 0600-State + Redaction. Merge-Normalisierung in getOrLoadProfile
(`lib/social-memory.js:83-91`) kennt nur v1-Felder.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Unit | `node --test test/social-memory.test.js test/local-prompts.test.js` | all pass |
| Tests | `npm test` | all pass, 0 fail |
| Parity | `node test/parity-matrix.mjs --check` | fully covered, exit 0 |

## Scope

**In scope**:
- `lib/social-memory.js` (extract-Branch + Merge-Normalisierung v2 + Self-Exclusion im Merge)
- `lib/config.js` + `openclaw.plugin.json` (`socialMemory.schemaV2`, default false)
- `test/social-memory.test.js` (v2-Cases)

**Out of scope**:
- Recall-Rendering v2 (Plan 021)
- open_threads → Proactive-Funnel (Plan 023)
- Der V2-Prompt-Text selbst (exists, getestet — nur agentName-Übergabe ergänzen, wo die Signatur es verlangt)

## Git workflow

- Branch: `advisor/020-schema-v2`
- 2 Commits; Stil `plan 020: …`

## Steps

### Step 1: Config-Flag

`schemaV2: false` in socialMemory-Defaults + Schema-Property (wie Plan 019
Step 1 Muster).

**Verify**: `node --test test/config.test.js` → pass.

### Step 2: extract() branchen + Merge v2

1. Import `buildMemoryExtractPromptV2` ergänzen.
2. In `extract(scope)`: bei `cfg?.socialMemory?.schemaV2 === true` das
   V2-Prompt bauen — inklusive `agentName`: resolve über
   `resolveAgentConfig(cfg, parsed.agentId).agentName` (Import aus
   config.js existiert bereits in social-memory.js:3) — V2 nutzt es für
   die Self-Exclusion-Zeile.
3. Merge-Normalisierung erweitern — pro Person aus `parsed.people`:
   ```js
   relationship: typeof data.relationship === "string" ? data.relationship.slice(0, 400) : (existing.relationship || ""),
   open_threads: Array.isArray(data.open_threads)
     ? data.open_threads.filter(t => t && typeof t === "object" && typeof t.topic === "string").slice(0, 3)
       .map(t => ({ topic: String(t.topic).slice(0, 120),
                    lastExchange: String(t.lastExchange || "").slice(0, 200),
                    whoOwesWhat: String(t.whoOwesWhat || "").slice(0, 120) }))
     : (existing.open_threads || []),
   emotional_state: typeof data.emotional_state === "string" ? data.emotional_state.slice(0, 200) : (existing.emotional_state || ""),
   emotionalStateUpdatedAt: data.emotional_state ? Date.now() : (existing.emotionalStateUpdatedAt || 0),
   ```
   Caps laut Design (facts ≤ 12 / prefs ≤ 6): die bestehende
   `slice(0, 20)`-Merge-Klammer bei schemaV2 auf 12/6 verengen (v1-Pfad
   unverändert).
4. `getOrLoadProfile`-Normalisierung (Z. 83-91) um die neuen Felder
   ergänzen (Typ-Guards wie oben, plus emotionalStateUpdatedAt number).
5. Defensiver Self-Exclusion-Merge: im Merge-Loop
   `if (isSelfName(cfg, name, parsed?.agentId)) continue;` — LLM kann die
   Prompt-Regel ignorieren; der Merge erzwingt sie.

**Verify**: `node --test test/social-memory.test.js` → pass.

### Step 3: Tests

1. schemaV2:true + Fake-llm returned v2-People (relationship,
   open_threads 4 Einträge, emotional_state) → Merge: relationship
   übernommen, open_threads auf 3 gekappt, emotionalStateUpdatedAt gesetzt.
2. v1-Felder laufen unter schemaV2 weiter (facts Cap 12).
3. Self-Eintrag im LLM-Output („Yuki" als Person) → im Merge übersprungen.
4. schemaV2:false → v1-Prompt + v1-Caps (bestehende Tests unverändert).
5. emotional_state-Verfall wird HIER NICHT getestet (Recall-Sache, Plan 021).
6. Parity-Rows am Ende: „schemaV2 extract captures relationship/open_threads
  /emotional_state with design caps + merge-level self-exclusion" +
  „schemaV2 is default-off (v1 behavior preserved)".

**Verify**: `npm test` → all pass; Parity fully covered.

## Test plan

Siehe Step 3. Muster: bestehende extract-Merge-Tests (Fake-llm
returns-people-JSON).

## Done criteria

- [ ] `rg -n "buildMemoryExtractPromptV2" lib/` → Import + Branch in social-memory.js
- [ ] `rg -n "schemaV2" lib/config.js openclaw.plugin.json` → Treffer
- [ ] `npm test` exit 0 inkl. v2-Cases; Parity fully covered
- [ ] `plans/README.md` Status-Row aktualisiert

## STOP conditions

- V2-Prompt-Signatur/Verhalten weicht vom Excerpt ab (gedriftet durch
  andere Wellen) → STOP.
- Die Caps (12/6) brechen einen bestehenden v1-Test, obwohl schemaV2 false
  ist → STOP (v1-Pfad darf sich NICHT ändern).
- Der Merge erweist sich als nicht deterministisch wegen der Plan-019
  geteilten Profil-Mutation → Report mit Repro.

## Maintenance notes

- Operator-Rollout: `socialMemory.schemaV2: true` live setzen, NACHDEM
  Plan 019 gelandet ist; die Extract-Prompts wachsen (~150 Tokens) —
  Extract-Cadence 25 bleibt.
- emotionalStateUpdatedAt ist die Frische-Marke für Plan 021 (Recall zeigt
  emotional_state nur frisch) und Plan 022 (Thread-Source).
- Extract-only ist die Anti-Halluzinations-Grenze: Jede künftige
  Feld-Erweiterung MUSS „only what is observed in dialogue" tragen.
- „Erst nach Operator-Review dieses Designs" (social-memory-v2.md Out of
  Scope) — dieser Plan IST die Wiring-Ausführung; das Design selbst bleibt
  unverändert.
