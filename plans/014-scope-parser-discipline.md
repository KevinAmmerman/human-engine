# Plan 014: Scope-Parser-Disziplin — alle Hand-Rollbacks auf scope.js/config.js umstellen

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git -C ~/human-engine diff --stat c4e148b..HEAD -- lib/scope.js lib/config.js lib/mood.js lib/naturalize.js lib/proactive.js lib/social-memory.js lib/dm-proactive.js`
> On mismatch with the "Current state" excerpts: STOP condition.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW (mechanische Substitution mit semantisch äquivalenten Funktionen; siehe Nachweis-Notes je Site)
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `c4e148b`, 2026-09-09

## Why this matters

Plan 001 (gelanded) machte `lib/scope.js` zum EINZIGEN Ort, der Session-Keys
parst — AGENTS.md und Wiki verbieten Hand-Parsing. Trotzdem parsen 5+ Stellen
weiter selbst (`includes(":group:")`, `startsWith("agent:")`, eigene
Predicates in mood.js). Die Multi-Tenancy-Welle hat die zentralen Predicates
geändert (Plan 005: `dmProactiveAgents`-Override, empty-agentId-Guard) — die
lokalen Kopien bekommen solche Änderungen nicht mit und laufen still
auseinander (genau der Fehler, den Plan 001 verhindern sollte). Hinzu: der
Composite-Scope `agentId::sessionKey` wird an 4 Stellen per Hand gesplittet.

## Current state

Verstöße (bei `c4e148b`; Zeilen evtl. durch spätere Commits verschoben —
Inhalt zählt):

```js
// lib/mood.js:146-148
function isGroupSessionKey(sk) { return typeof sk === "string" && sk.includes(":group:"); }
// lib/mood.js:239-247 — lokale Kopien von isEnabled/isScopedAgent (Semantik
// aktuell identisch zu config.js, aber kopiert statt importiert)
// lib/naturalize.js:324
const isGroup = (typeof sk === "string" && sk.includes(":group:")) || state.chatTypeBySession.get(sk) === "group";
// lib/proactive.js:399
const isGroup = opts.isGroup === true || (typeof sk === "string" && sk.includes(":group:"));
// lib/social-memory.js:35-39 — parseScope(scope) via lastIndexOf("::")
function parseScope(scope) { const last = scope.lastIndexOf("::"); ... }
// lib/dm-proactive.js — deriveDmFromEvent: sc.indexOf("::") + slice (Z. ~570),
// scopeKey-Konstruktion Z. ~54
```

Zentral: `lib/scope.js` exportiert `isGroupSessionKey`, `isDmSessionKey`,
`parseScope`, `agentIdFromSessionKey`, `channelAndRestFromSessionKey`,
`isChatSession`; `lib/config.js` exportiert `isEnabled`, `isScopedAgent`,
`isScopedDmAgent`, `dmProactiveAgents`. `lib/gate.js:11` re-exportiert
`isGroupSessionKey` bereits — mood/naturalize/proactive könnten über gate
importieren, aber direkter Import aus `./scope.js` ist sauberer (kein
Kreis-Import-Risiko: scope.js importiert nur config-freie Utils).

Frühere Entscheidung (plans/README „considered and rejected"): die
mood.js-Konsolidierung wurde während Welle 001–008 wegen Churn-Risikos
deferred — NACH der Welle ist sie jetzt sauber machbar; dieser Plan hebt die
Deferral auf (begründet: Plan 005 hat die zentralen Predicates geändert).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Unit | `npm test` | all pass, 0 fail |
| Parity | `node test/parity-matrix.mjs --check` | fully covered, exit 0 |

## Scope

**In scope**:
- `lib/scope.js` (NEU: `parseAgentScope(composite)`; interne
  parseSessionKey/parseScope-Konsolidierung)
- `lib/mood.js`, `lib/naturalize.js`, `lib/proactive.js`,
  `lib/social-memory.js`, `lib/dm-proactive.js` (nur die genannten Sites)
- Tests der Module (nur bei Bruch; neue Tests: scope-API)

**Out of scope**:
- `lib/dm-proactive.js:566` Regex `/:group:|@g\.us|:topic:|:slash:/` auf dem
  RAW `event.to` (kein Session-Key, sondern Kanal-Ziel — bewusst eigenständig)
- `lib/naturalize.js:92-94` startsWith("agent:")-Guard vor
  `channelAndRestFromSessionKey` (delegiert bereits an scope.js — lassen)
- Verhaltensänderungen: reine Substitution

## Git workflow

- Branch: `advisor/014-scope-discipline`
- 2–3 Commits (scope.js first, dann Module); Stil `plan 014: …`

## Steps

### Step 1: scope.js — parseAgentScope + interne Konsolidierung

1. Neue Export-Funktion:
   ```js
   export function parseAgentScope(composite) {
     if (typeof composite !== "string" || !composite) return null;
     const last = composite.lastIndexOf("::");
     if (last < 0) return null;
     return { agentId: composite.slice(0, last), sessionKey: composite.slice(last + 2) };
   }
   ```
2. Interne Redundanz: `parseSessionKey` und `parseScope` duplizieren denselben
   Split — implementiere `parseScope` als dünner Wrapper um denselben Kern
   (oder umgekehrt), öffentliche Signaturen/Outputs bleiben unverändert.
3. Unit-Tests in `test/scope.test.js`: parseAgentScope happy path
   (`"hori::agent:hori-wa:whatsapp:group:X"`), ohne `::` → null, Session-Key
   enthält selbst `::` → lastIndexOf-Verhalten.

**Verify**: `node --test test/scope.test.js` → pass.

### Step 2: mood.js umstellen

1. Lokale `isGroupSessionKey` löschen → `import { isGroupSessionKey } from "./scope.js"`.
2. Lokale `isEnabled`/`isScopedAgent` (Z. ~239-247) löschen → `import { isEnabled, isScopedAgent } from "./config.js"`.
   Semantik-Nachweis (im Commit-Body dokumentieren): config.isEnabled ==
   `cfg.enabled === true` == mood-Kopie; config.isScopedAgent hat zusätzlich
   den empty-agentId-Guard — für `agentId === ""` liefern BEIDE `false`
   (bei nicht-leerer Allowlist) — kein Verhaltensunterschied auf den
   aktuellen Call-Sites.
3. Lokale `pathSafe` in mood.js löschen → aus einem gemeinsamen Modul
   importieren: exportiere `pathSafe` aus `lib/observed-store.js`?
   Sauberer: in `lib/scope.js` (pathSafe gehört zur Key-Hygiene) exportieren
   und in observed-store/social-memory/mood/proactive importieren (die
   eigenen Kopien fallen). Wenn observed-store/social-memory/proactive
   unverändert bleiben sollen (geringeres Konfliktrisiko), MINDESTENS mood
   umstellen; die anderen drei sind optionaler Bonus-Step — entscheiden per
   Aufwand, Commit-Message klar machen, was gewechselt wurde.

**Verify**: `node --test test/mood.test.js test/scope.test.js` → pass.

### Step 3: naturalize.js + proactive.js umstellen

```js
// naturalize.js:324
const isGroup = isGroupSessionKey(sk) || state.chatTypeBySession.get(sk) === "group";
// proactive.js:399
const isGroup = opts.isGroup === true || isGroupSessionKey(sk);
```
Imports ergänzen. (Semantik: `isGroupSessionKey` prüft die `:group:`-Kind
im Key — identisch zum bisherigen `includes`.)

**Verify**: `node --test test/naturalize.test.js test/proactive.test.js` → pass.

### Step 4: Composite-Scope-Sites umstellen

1. `lib/social-memory.js` `parseScope(scope)` (Z. 35-39) → Aufruf von
   `parseAgentScope` aus scope.js (Funktionsname lokal behalten als Alias
   oder Call-Sites direkt umbiegen).
2. `lib/dm-proactive.js` deriveDmFromEvent: den `sc.indexOf("::") +
   sc.slice(...)`-Block → `parseAgentScope(sc)` (Ziel bleibt
   `{agentId, sessionKey: skPart}` — Attributnamen beachten).

**Verify**: `node --test test/social-memory.test.js test/dm-proactive.test.js` → pass; `npm test` → all pass; Parity fully covered.

### Step 5: Vertrags-Test gegen Regression

Neuer Test (z.B. `test/scope.test.js` erweitert): ein Grep-artiger
Contract-Test ist in node:test unidiomatisch — stattdessen: keine. Der
Vertrag lebt in AGENTS.md; Reviewer prüft Diffs. (Bewusst KEIN
grep-Assert-Test — false positives bei legitimen String-Vergleichen.)

**Verify**: `npm test` → all pass.

## Test plan

Siehe Steps. Muster: test/scope.test.js. Alle bestehenden Modul-Tests sind
der Substitutions-Anker und MÜSSEN unverändert grün bleiben.

## Done criteria

- [ ] `rg -n 'includes\(":group:"\)' lib/` → keine Treffer
- [ ] `rg -n "function isEnabled|function isScopedAgent" lib/mood.js` → keine Treffer
- [ ] `rg -n "parseAgentScope" lib/` → Treffer in scope.js + social-memory.js + dm-proactive.js
- [ ] `npm test` exit 0; Parity fully covered
- [ ] `plans/README.md` Status-Row aktualisiert

## STOP conditions

- Ein Substitutionssite hat NICHT die dokumentierte Semantik (z.B. mood.js
  verhält sich nach dem Import-Wechsel anders als vorher in einem
  bestehenden Test) → STOP, Report mit dem diff-ten Test.
- Excerpts passen inhaltlich nicht zu `c4e148b`.

## Maintenance notes

- `parseAgentScope` ist ab jetzt der EINZIGE Ort für `agentId::sessionKey`.
  Neue Module importieren es; AGENTS.md-Konvention gilt.
- Wenn Plan 005-artige Overrides künftig erweitert werden (z.B.
  mood-eigene Allowlist), passiert das jetzt in config.js — mood erbt
  automatisch.
- Reviewer-Fokus: keine Verhaltensdiffs — nur Import-Zeilen und
  Funktionsaufrufe dürfen sich ändern.
