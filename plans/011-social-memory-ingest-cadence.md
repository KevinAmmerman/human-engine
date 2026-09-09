# Plan 011: Social-Memory-Ingest-Kadenz fixen — keine 2–3×-Zählung pro Nachricht, keine Empty-Text-Ingests

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git -C ~/human-engine diff --stat c4e148b..HEAD -- lib/gate.js lib/social-memory.js test/social-memory.test.js`
> On mismatch with the "Current state" excerpts: STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW-MED (Dedup-Fenster 60 s; Metadaten dürfen nicht mehrfach zählen, aber weiterhin pro echter Nachricht wachsen)
- **Depends on**: none
- **Category**: perf / correctness
- **Planned at**: commit `c4e148b`, 2026-09-09

## Why this matters

Jede eingehende Gruppennachricht läuft durch bis zu drei Hooks, die alle
`ingestSocial` rufen: `message_received` (gate.js:194),
`before_agent_reply` (gate.js:229) und `before_agent_run` (gate.js:427).
Jeder `ingest()` inkrementiert `newSinceExtract` UND
`mentionCount`/`messageCount` — d.h. die Extract-LLM (maxTokens 1200, 30 s)
feuert bei `extractEvery: 25` real alle ~9–13 statt 25 Nachrichten
(~2–3× LLM-Kosten pro Scope), und `mentionCount` zählt Hook-Fireings statt
Nachrichten (Datenqualität für künftigen Recall-Score). Zusätzlich werden
Text-leere Ingests (Media-only, `text: ""`) als Buffer-Entries gespeichert
und vergiften die Extraction mit Leerzeilen.

## Current state

`lib/gate.js:121-125`:

```js
function ingestSocial(sk, agentId, speaker, text) {
  if (!socialMemory || !isChatSession(sk)) return;
  const scope = (agentId || "?") + "::" + sk;
  socialMemory.ingest(scope, { speaker, text, ts: Date.now() });
}
```

Drei Call-Sites: `onMessageReceived` (~Z. 194, nur wenn `isEnabled &&
isScopedAgent`), `onBeforeAgentReply` (~Z. 229, nur wenn `prompt`),
`onBeforeAgentRun` (~Z. 427, nur wenn `prompt`).

`lib/social-memory.js:156-189` (ingest, Auszug):

```js
function ingest(scope, { speaker, text, ts }) {
  try {
    if (!scope || !speaker || !isEnabled()) return;
    const parsed = parseScope(scope);
    if (isSelfName(cfg, speaker, parsed?.agentId)) return;
    const buf = getBuffer(scope);
    buf.entries.push({ speaker, text, ts: ts || Date.now() });
    if (buf.entries.length > MAX_BUFFER) { /* trim */ }
    buf.newSinceExtract++;
    const profile = getOrLoadProfile(scope);
    if (profile.people[speaker]) {
      profile.people[speaker].lastSeenTs = ts || Date.now();
      profile.people[speaker].mentionCount = (profile.people[speaker].mentionCount || 0) + 1;
    } else { /* Neuanlage */ }
    profile.messageCount = (profile.messageCount || 0) + 1;
    writeProfile(scope, profile);
    // ... extract trigger bei buf.newSinceExtract >= extractEvery ...
  } catch {}
}
```

Beachte: `text` wird NICHT geprüft — Empty-Ingests landen im Buffer.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Unit | `node --test test/social-memory.test.js` | all pass |
| Tests | `npm test` | all pass, 0 fail |
| Parity | `node test/parity-matrix.mjs --check` | fully covered, exit 0 |

## Scope

**In scope**:
- `lib/social-memory.js` (nur `ingest`: Empty-Guard + kurzes
  Letzter-Ingest-Dedup)
- `test/social-memory.test.js` (neue Cases)

**Out of scope**:
- `lib/gate.js` (Call-Sites bleiben — Dedup passiert im Memory-Modul,
  damit auch andere künftige Ingest-Quellen abgedeckt sind)
- Extract-Trigger-Logik, Buffer-Cap, MAX_BUFFER
- Recall/Extraction selbst

## Git workflow

- Branch: `advisor/011-ingest-cadence`
- 1 Commit; Stil `plan 011: …`

## Steps

### Step 1: Empty-Guard

In `ingest` nach dem Speaker-Check:

```js
if (!text || !String(text).trim()) return;
```

(Auch Media-only-Nachrichten haben keinen Memory-Wert; der Marker `[image]`
als `prompt`-Text wird weiterhin normal ingestet, weil `displayText` den
Marker setzt — gate.js:227 nutzt `displayText` nur für den Peek,
`ingestSocial` bekommt `prompt`; Media-only hat `prompt === ""` → jetzt
sauber geskippt.)

**Verify**: `node --test test/social-memory.test.js` → pass (neue Cases
Step 3).

### Step 2: Letzter-Ingest-Dedup (60 s, gleicher Speaker + gleicher Text)

Kleiner in-Memory-Guard im Factory-Closure:

```js
const lastIngestSigByScope = new Map(); // scope -> { speaker, text, ts }
// in ingest(), NACH parseScope/isSelfName, VOR buf-push:
const sig = lastIngestSigByScope.get(scope);
if (sig && sig.speaker === speaker && sig.text === String(text) &&
    (ts || Date.now()) - sig.ts < 60_000) {
  return; // gleiche Nachricht im Hook-Refire — nicht erneut zählen
}
lastIngestSigByScope.set(scope, { speaker, text: String(text), ts: ts || Date.now() });
if (lastIngestSigByScope.size > 1024) lastIngestSigByScope.delete(lastIngestSigByScope.keys().next().value);
```

Dokumentierter Kompromiss (Code-Kommentar): dieselbe Person schickt zweimal
identischen Text innerhalb 60 s → zweite echte Nachricht wird als Refire
gefiltert (selten; Hook-Refire des selben Texts ist der dominante Fall).
In `stop()` die Map NICHT clearen müssen (ephemeral, unref'd okay) — aber
sauber mitclearen, wenn trivial.

**Verify**: `node --test test/social-memory.test.js` → pass; `npm test`.

### Step 3: Tests (Muster: bestehende ingest-Tests)

1. Dreifach-Ingest desselben `{speaker, text}` innerhalb <60 s →
   `buf.entries.length === 1`, `newSinceExtract === 1`,
   `mentionCount === 1`, `messageCount === 1`.
2. Nach 61 s (fake clock/`ts`-Param) wird derselbe Text erneut gezählt.
3. Zwei verschiedene Speaker, gleicher Text, <60 s → beide gezählt.
4. `text: ""` → kein Eintrag, kein Zählerstand.
5. Bestehender Cadence-Test (extract bei extractEvery) bleibt grün und
   bedeutet jetzt echte Nachrichten.

**Verify**: `npm test` → all pass; Parity fully covered.

## Test plan

Siehe Step 3. Der bestehende Test „coalescing/race" bleibt Anker.

## Done criteria

- [ ] `npm test` exit 0 inkl. neuer Cases; Parity fully covered
- [ ] `grep -n "lastIngestSigByScope" lib/social-memory.js` → Treffer (Map + Set + Guard)
- [ ] `git status` nur In-Scope-Dateien
- [ ] `plans/README.md` Status-Row aktualisiert

## STOP conditions

- Excerpts passen nicht zu `c4e148b`.
- Ein bestehender Cadence/Race-Test bricht inhaltlich → melden.
- Die 60-s-Annahme erweist sich im Testaufbau als unpraktikabel (ts-Quellen
  inkonsistent) → melden, nicht improvisieren.

## Maintenance notes

- Nach diesem Plan ist `extractEvery: 25` wieder „25 echte Nachrichten".
- Recall-Score-Design (Plan 021) darf `mentionCount` als Beteiligungs-Metric
  nutzen — sie zählt jetzt echte Nachrichten.
- Der 60-s-Kompromiss ist bewusst grob; wenn künftig Message-IDs vom Host
  verfügbar sind, auf ID-Dedup umstellen.
