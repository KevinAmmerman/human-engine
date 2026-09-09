# Plan 001: Kanonischen Session-Scope-Parser `lib/scope.js` einführen und die 5+ divergenten Parser konsolidieren

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git -C ~/human-engine diff --stat e9216df..HEAD -- lib/ index.js test/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (Refactor der Fail-open/Fail-closed-Klassifikation — Drift ändert Gate-Verhalten still)
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `e9216df`, 2026-09-09

## Why this matters

Session-Keys sind das einzige Tenancy-Merkmal des Plugins: Sie betten
`agent:<agentId>:<channel>:<kind>:<chatId>` ein. Heute parsen **fünf+
Stellen** dieses Format ad hoc mit divergenten Split-Indices und
**drei verschiedene DM/Group-Regexes**. Jede Erweiterung (neuer Channel-Typ,
neues Key-Segment) bricht mehrere Parser still — genau die Incident-Klasse
536/546 (`sessionKey` fehlte in Production-ctx; Scope-Ableitung failte
still). Dieser Plan führt EINEN kanonischen Parser ein, auf den alle
Module umstellen; alle Folge-Pläne (002–005) bauen auf ihm auf.

## Current state

Repo: `~/human-engine/` (PUBLIC — keine echten Nummern/Session-Keys in
Fixtures; nur offensichtlich fake Werte wie `999999999`/`1203…@g.us`-artige
Beispiele). Plain ES modules, Node 24+, node:test, kein Build/Lint.
Session-Key-Format (live verifiziert):
`agent:<agentId>:<channel>:<kind>:<rest>` mit kind ∈ {direct, group, …};
Heartbeat-Sessions: `…:heartbeat…`.

Die duplizierten Parser heute:

1. `index.js:85-87` (`readSessionTranscript`):
   ```js
   const agentId = typeof sessionKey === "string" && sessionKey.startsWith("agent:")
     ? sessionKey.split(":")[1]
     : undefined;
   ```
2. `lib/gate.js:12,39-47`:
   ```js
   const CHAT_SESSION_RE = /:(whatsapp|telegram|discord|signal|slack|matrix):/;
   export function isGroupSessionKey(sk) {
     return typeof sk === "string" && sk.includes(":group:");
   }
   export function isChatSession(sk) {
     if (typeof sk !== "string") return false;
     if (sk.includes(":heartbeat")) return false;
     return CHAT_SESSION_RE.test(sk);
   }
   ```
   und `lib/gate.js:165` (agentId-Ableitung, identisch zu index.js):
   ```js
   const agentId = ctx?.agentId || (typeof sk === "string" && sk.startsWith("agent:") ? sk.split(":")[1] : undefined);
   ```
3. `lib/naturalize.js:21-30` (Kommentar sagt: „exact copy of dm-proactive.js:48,54-58"):
   ```js
   const DM_CHANNEL_RE = /:(whatsapp|telegram|discord|signal|slack|matrix):/;
   function isDmSessionKey(sk) {
     if (typeof sk !== "string") return false;
     if (sk.includes(":heartbeat")) return false;
     if (sk.includes(":group:")) return false;
     return DM_CHANNEL_RE.test(sk);
   }
   ```
   und `lib/naturalize.js:101-104` (TTS-Channel = alles nach agentId):
   ```js
   if (!channel && typeof sk === "string" && sk.startsWith("agent:")) {
     // "agent:<agentId>:<channel>..." → channel id used by the TTS settings resolver
     channel = sk.split(":").slice(2).join(":");
   }
   ```
   und `lib/naturalize.js:132-135`:
   ```js
   function scopeFromSessionKey(sk) {
     if (typeof sk !== "string" || !sk.startsWith("agent:")) return null;
     return sk.split(":")[1] || null;
   }
   ```
4. `lib/dm-proactive.js:48,54-59`:
   ```js
   const DM_CHANNEL_RE = /:(whatsapp|telegram|discord|signal|slack|matrix):/;
   function isDmSession(sk) {
     if (typeof sk !== "string") return false;
     if (sk.includes(":heartbeat")) return false;
     if (sk.includes(":group:")) return false;
     return DM_CHANNEL_RE.test(sk);
   }
   ```
   und `lib/dm-proactive.js:513-516` (Regex-Parse im Scope-Matcher):
   ```js
   const m = skPart.match(/^agent:([^:]+):([^:]+):([^:]+):([^:]+)$/);
   if (!m) continue;
   const [, agentId, ch, kind, target] = m;
   ```
5. `lib/proactive.js:77-80`:
   ```js
   export function agentIdFromSessionKey(sk) {
     if (typeof sk !== "string" || !sk.startsWith("agent:")) return null;
     return sk.split(":")[1] || null;
   }
   ```
   (`dm-proactive.js` importiert diesen Export — Z. 3.)

Konventionen: Hausstil ist Modul-für-Modul mit Kommentar-Verweis auf den
Plan (Beispiel: `lib/naturalize.js:21-23` „Plan 587: … Local helper per
house convention"). Log-Präfix `human-engine:`. Tests: node:test mit
inline fakes, Muster `test/messages.test.js` (reine Funktions-Tests).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Tests | `cd ~/human-engine && npm test` | all pass, 0 fail |
| Parity | `cd ~/human-engine && node test/parity-matrix.mjs --check` | `51/51 covered`, exit 0 |
| Smoke | `cd ~/human-engine && node -e "import('./lib/scope.js').then(m => console.log(JSON.stringify(m.parseSessionKey('agent:hori-wa:whatsapp:group:1203@g.us'))))"` | `{"agentId":"hori-wa","channel":"whatsapp","kind":"group","rest":"1203@g.us"}` |

## Scope

**In scope** (die einzigen Dateien, die du änderst):
- `~/human-engine/lib/scope.js` (NEU)
- `~/human-engine/test/scope.test.js` (NEU)
- `~/human-engine/index.js` (nur agentId-Ableitung Z. 85-87 → scope.js)
- `~/human-engine/lib/gate.js` (nur Z. 12, 39-47, 165 → scope.js)
- `~/human-engine/lib/naturalize.js` (nur Z. 21-30, 101-104, 132-135 → scope.js)
- `~/human-engine/lib/dm-proactive.js` (nur Z. 48, 54-59, 513-516 → scope.js)
- `~/human-engine/lib/proactive.js` (nur Z. 77-80 → re-export aus scope.js, siehe Step 4)

**Out of scope** (NICHT anfassen):
- `lib/config.js`, `openclaw.plugin.json` — Config-Modell kommt in Plan 002.
- `lib/contacts.js`, `lib/persona.js`, `lib/voice-card.js` — Plan 003/004.
- Jegliches Verhalten: Klassifikationsergebnisse müssen byte-identisch sein.
- `bin/followup-gate.mjs`, `lib/dm-gate-core.js`.

## Git workflow

- Branch: `advisor/001-scope-parser`
- Commit pro Step; Message-Stil wie `git log --oneline` (z. B.
  `plan 001: canonical session-scope parser` bzw. konventionell
  `refactor(scope): …`).
- NICHT pushen und NICHT auf main mergen ohne Operator-Anweisung.

## Steps

### Step 1: `lib/scope.js` anlegen

Neues Modul mit EXAKT diesem Verhalten (alle alten Helfer werden drauf
abgebildet, keines ändert sein Ergebnis):

```js
const CHANNEL_RE = /:(whatsapp|telegram|discord|signal|slack|matrix):/;

// agent:<agentId>:<rest…> — rest ist "whatsapp:group:1203@g.us" o. ä.
export function parseSessionKey(sk) {
  if (typeof sk !== "string" || !sk.startsWith("agent:")) return null;
  const cut = sk.indexOf(":");
  const rest = sk.slice(cut + 1);
  const agentId = rest.slice(0, rest.indexOf(":")) || null;
  return { agentId, rest, raw: sk };
}

export function agentIdFromSessionKey(sk) {
  const p = parseSessionKey(sk);
  return p ? p.agentId : null;
}

// Returns { agentId, channel, kind, rest } or null.
// kind: zweites Segment nach dem Channel ("direct"/"group"/…), falls vorhanden.
export function parseScope(sk) {
  if (typeof sk !== "string" || !sk.startsWith("agent:")) return null;
  const parts = sk.split(":");          // ["agent", agentId, channel, kind, …rest]
  if (parts.length < 3) return { agentId: parts[1] || null, channel: null, kind: null, rest: null };
  const [, agentId, channel, kind = null, ...restArr] = parts;
  return { agentId: agentId || null, channel, kind, rest: restArr.length ? restArr.join(":") : null };
}

export function isChatSession(sk) {
  if (typeof sk !== "string") return false;
  if (sk.includes(":heartbeat")) return false;
  return CHANNEL_RE.test(sk);
}

export function isGroupSessionKey(sk) {
  return typeof sk === "string" && sk.includes(":group:");
}

// Identisch zu naturalize/dm-proactive isDmSession: chat-channel, kein
// heartbeat, keine Gruppe.
export function isDmSessionKey(sk) {
  if (typeof sk !== "string") return false;
  if (sk.includes(":heartbeat")) return false;
  if (sk.includes(":group:")) return false;
  return CHANNEL_RE.test(sk);
}

// naturalize.js TTS-Kanal: alles NACH "agent:<agentId>:" unverändert.
export function channelAndRestFromSessionKey(sk) {
  if (typeof sk !== "string" || !sk.startsWith("agent:")) return null;
  return sk.split(":").slice(2).join(":") || null;
}
```

**Verify**: Smoke-Command aus der Tabelle → erwartete Ausgabe; zusätzlich
`node -e "import('./lib/scope.js').then(m => { console.log(m.isDmSessionKey('agent:a:whatsapp:direct:999'), m.isDmSessionKey('agent:a:whatsapp:group:1@g.us'), m.isChatSession('agent:a:heartbeat'), m.agentIdFromSessionKey('agent:x:telegram:direct:1')); })"` → `true false false x`.

### Step 2: `test/scope.test.js` anlegen

Unit-Tests (Muster: `test/messages.test.js`): parseSessionKey/parseScope/
isDmSessionKey/isGroupSessionKey/isChatSession/agentIdFromSessionKey/
channelAndRestFromSessionKey. Pflichtfälle: DM-Key, Group-Key
(`@g.us`), Heartbeat, nicht-`agent:`-Key, leere Strings,
`agent:only-two-segments`, TTS-rest-Identität
(`channelAndRestFromSessionKey('agent:a:whatsapp:group:x@y') === 'whatsapp:group:x@y'`).
NUR fake Werte (Repo ist PUBLIC).

**Verify**: `cd ~/human-engine && node --test test/scope.test.js` → all pass.

### Step 3: Konsumenten umstellen (behavior-identisch)

1. `lib/gate.js`: `CHAT_SESSION_RE`, `isGroupSessionKey`, `isChatSession`
   (Z. 12, 39-47) löschen; importiere `isChatSession`,
   `isGroupSessionKey` aus `./scope.js`. Achtung: `isChatSession`/
   `isGroupSessionKey` sind EXPORTS von gate.js (Z. 39-47 `export function`)
   und werden von `voice-card.js:5` importiert — behalte die Re-Exports:
   `export { isChatSession, isGroupSessionKey } from "./scope.js";` am
   passenden Platz. Zeile 165: `const agentId = ctx?.agentId ||
   agentIdFromSessionKey(sk);` mit Import aus `./scope.js`.
2. `lib/naturalize.js`: lokale `DM_CHANNEL_RE`/`isDmSessionKey` (Z. 21-30)
   und `scopeFromSessionKey` (Z. 132-135) löschen; benutze
   `isDmSessionKey`/`agentIdFromSessionKey` aus `./scope.js`. Den
   TTS-Channel-Ausdruck (Z. 101-103) durch
   `channel = channelAndRestFromSessionKey(sk) || channel;` ersetzen
   (nur wenn `!channel` und sk mit `agent:` beginnt — gleiche Guard wie
   heute). Plan-587-Kommentar entfernen/ersetzen („superseded by
   scope.js, Plan 001").
3. `lib/dm-proactive.js`: lokale `DM_CHANNEL_RE` + `isDmSession`
   (Z. 48, 54-59) löschen; `isDmSessionKey` aus `./scope.js` importieren
   und alle `isDmSession(`-Aufrufe umbenennen. Den Scope-Matcher
   (Z. 513-516) ersetzen: `const parsed = parseScope(skPart); if (!parsed ||
   parsed.channel !== channel || parsed.kind !== "direct" || parsed.rest !==
   target) continue; owners.push(parsed.agentId);` — SEMANTIK ERHALTEN
   (nur vollständige 4-Segment-Keys matchen wie der alte Regex; wenn
   `parseScope` bei weniger Segmenten nicht `null` liefert, hier explizit
   `parts.length >= 5`-Äquivalent prüfen: parsed.rest muss truthy und
   segmentfrei sein — vergleiche mit dem alten Regex-Verhalten und dokumentiere
   die Wahl im Code).
4. `lib/proactive.js`: `agentIdFromSessionKey` (Z. 77-80) wird zu
   `export { agentIdFromSessionKey } from "./scope.js";` (dm-proactive.js
   importiert den Export weiterhin unverändert aus `./proactive.js` —
   Re-Export hält die Importpfade stabil; ODER Importpfade in
   dm-proactive.js direkt auf scope.js umstellen und in proactive.js
   entfernen. Wähle Variante B [direkt umstellen], wenn alle Treffer
   grep-bar sind).
5. `index.js`: agentId-Ableitung Z. 85-87 →
   `const agentId = agentIdFromSessionKey(sessionKey);` mit Import.

**Verify**: `cd ~/human-engine && npm test` → all pass; `grep -rn
"split(\":\")\[1\]" lib/ index.js` → nur noch Treffer in `lib/scope.js`;
`grep -rn "DM_CHANNEL_RE" lib/` → nur noch in `lib/scope.js` (falls du
den Namen dort übernommen hast — Empfehlung: `CHANNEL_RE`).

### Step 4: Parität absichern

`node test/parity-matrix.mjs --check` → 51/51. Falls eine Row die alten
lokalen Symbole importiert hatte (nicht erwartet — Matrix testet
Verhalten über Hooks), hier anpassen und im Commit erwähnen.

**Verify**: wie oben.

## Test plan

- Neu: `test/scope.test.js` (Step 2, alle Klassifikations-Fälle).
- Regression: bestehende Suites `gate.test.js`, `naturalize.test.js`,
  `dm-proactive.test.js`, `index.test.js` müssen UNVERÄNDERT grün bleiben.
- Verification: `cd ~/human-engine && npm test` → all pass, inkl. neuer
  scope-Tests; Parity 51/51.

## Done criteria

- [ ] `lib/scope.js` existiert mit den 7 Funktionen; `npm test` exit 0
- [ ] `node test/parity-matrix.mjs --check` exit 0, `51/51 covered`
- [ ] `grep -rn "whatsapp|telegram|discord|signal|slack|matrix" lib/ index.js` → nur `lib/scope.js`
- [ ] `grep -rn 'split(":")\[1\]' lib/ index.js` → nur `lib/scope.js` (falls überhaupt)
- [ ] `git status` zeigt keine Dateien außerhalb der In-Scope-Liste
- [ ] `plans/README.md` Status-Row aktualisiert

## STOP conditions

- Die Code-Ausschnitte in „Current state" stimmen nicht mehr (Drift).
- Ein bestehender Test muss zur Umstellung INHALTLICH geändert werden
  (nicht nur Import-Pfade) — dann verhält sich scope.js nicht byte-identisch
  zur alten Logik: stoppen und den Diff der Klassifikation melden.
- `parseScope` kann den 4-Segment-Regex-Fall
  (`dm-proactive.js:513-516`) nicht ohne semantische Abweichung abbilden —
  nicht improvisieren; den Fall im Report beschreiben.

## Maintenance notes

- Alle Folge-Pläne (002–005) importieren scope.js — der Parser ist die
  Tenancy-Achse. Wer später ein neues Key-Segment ergänzt, muss NUR
  scope.js + parseScope erweitern.
- Reviewer-Schwerpunkt: reine Verhaltensgleichheit (diff der
  Klassifikationsergebnisse über die Fixture-Fälle in
  `test/scope.test.js` + bestehende Suites).
- `lib/mood.js` besitzt eine eigene `isScopedAgent`-Kopie (config.js) —
  bewusst NICHT Teil dieses Plans (kein Session-Key-Parsing).
