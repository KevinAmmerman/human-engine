# Plan 012: Log-Redaction + State-Dir-Perms — rohe Session-Keys aus Fehler-Logs verbannen, 0700 durchsetzen

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git -C ~/human-engine diff --stat c4e148b..HEAD -- lib/observed-store.js lib/social-memory.js lib/proactive.js lib/dm-proactive.js lib/voice-card.js index.js`
> On mismatch with the "Current state" excerpts: STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (Log-Format + idempotente chmods; keine Verhaltensänderung)
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `c4e148b`, 2026-09-09

## Why this matters

Session-Keys enthalten echte Telefon-/Gruppen-IDs
(`agent:hori-wa:whatsapp:group:4917624677323-…@g.us`). `redactSessionKey`
(digit-runs → letzte 4) ist das etablierte Muster und wird auf den
Haupt-Pfaden korrekt benutzt — aber Fehler-/Bookkeeping-Pfade loggen rohe
Keys/Scopes (`observed-store.js:49,81,87`, `social-memory.js:147,275`,
`proactive.js:384,416`, `dm-proactive.js:598` loggt `to=` = Telefonnummer).
Diese Logs landen im Gateway-Log. Zusätzlich wurden auf der Live-Maschine
`state/` und `state/social-memory/` mit 0775 statt 0700 gemessen (Dateien
selbst sind 0600) — Verzeichnis-Listing für lokale Nutzer möglich.

## Current state

Muster (existiert, verwenden): `lib/redact.js` → `redactSessionKey(sk)`
(kürzt digit-runs auf letzte 4). Haupt-Pfad-Beispiele: `gate.js:133`,
`naturalize.js:168`.

Fehler-Sites (bei `c4e148b`):

```js
// lib/observed-store.js:49
_log.warn(`human-engine: observed-store: append error for ${sessionKey}: ${err?.message || err}`);
// lib/observed-store.js:81
_log.warn(`human-engine: observed-store: skipping corrupt line in ${sessionKey}: ${String(line).slice(0, 80)}`);
// lib/observed-store.js:87
_log.warn(`human-engine: observed-store: read error for ${sessionKey}: ${err?.message || err}`);
// lib/observed-store.js:26 (Pfad enthält pathSafe(sessionKey) MIT Ziffern!)
_log.warn(`human-engine: observed-store: count error for ${file}: ${err?.message || err}`);
// lib/social-memory.js:147
_log.warn(`human-engine: social-memory: write error for ${scope}: ${err?.message || err}`);
// lib/social-memory.js:275
_log.warn(`human-engine: social-memory: extract error for ${scope}: ${err?.message || err}`);
// lib/dm-proactive.js (~598, deriveDmFromEvent fail-open)
_log.warn(`human-engine: dm-proactive: cannot derive DM scope for to=${to} channel=${channel} (…) — pass-through`);
// lib/proactive.js (~384, ~416): `scope=${scope}` in Log-Zeilen
```

Perms: `state/` = 775, `state/social-memory/` = 775 (gemessen 2026-09-09;
Dateien 600, `state/observed` 700). `ensureDir` in social-memory.js:72-75
chmod'd nur das tiefste Verzeichnis; wer `state/` zuerst anlegt
(verschiedene Module mit `mkdirSync` ohne nachträgliches chmod in
Kombination mit umask) kann 0775 hinterlassen.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Unit | `node --test test/observed-store.test.js test/social-memory.test.js test/proactive.test.js test/dm-proactive.test.js` | all pass |
| Tests | `npm test` | all pass, 0 fail |

## Scope

**In scope**:
- `lib/observed-store.js`, `lib/social-memory.js`, `lib/proactive.js`,
  `lib/dm-proactive.js` (nur die genannten Log-Zeilen)
- `index.js` (einmaliger Startup-chmod des stateDir + Unterordner)
- Tests der betroffenen Module (nur falls Log-Assertions existieren)

**Out of scope**:
- `lib/redact.js` (unverändert benutzen)
- Parity-Matrix (keine Verhaltens-Row)
- Log-Format-Umstrukturierungen über die Redaktion hinaus

## Git workflow

- Branch: `advisor/012-redaction-perms`
- 1 Commit; Stil `plan 012: …`

## Steps

### Step 1: Log-Zeilen redacten

1. In jeder genannten Zeile `${sessionKey}` → `${redactSessionKey(sessionKey)}`
   (Import ergänzen, wo fehlt). Gleiches für `${scope}` in
   social-memory/proactive: scope = `agentId::sessionKey` —
   `redactSessionKey(scope)` funktioniert (kürzt digit-runs im Session-Teil).
2. `observed-store.js:26`/`:63`: `${file}` → nur den Dateinamen-Basis redacten
   oder einfacher: `for ${redactSessionKey(sessionKey)}` verwenden (die
   Funktion kennt sessionKey im Scope; count/rotate haben ggf. nur `file` —
   dort: `err?.code` + redactierter Basisname über
   `path.basename(file).replace(/\d{5,}/g, m => m.slice(-4))` — simpel
   halten, Hauptziel: keine 6+ Ziffern im Log).
3. `dm-proactive.js` deriveDmFromEvent-Warnung: `to=***${String(to).replace(/\D/g,"").slice(-4)}`
   (Telefonnummer → letzte 4).

**Verify**: `node --test test/observed-store.test.js test/social-memory.test.js test/proactive.test.js test/dm-proactive.test.js` → pass.

### Step 2: Startup-Perms

In `index.js register()`, nach `stateDir`-Auflösung:

```js
try {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  for (const d of fs.readdirSync(stateDir, { withFileTypes: true })) {
    if (d.isDirectory()) { try { fs.chmodSync(path.join(stateDir, d.name), 0o700); } catch {} }
  }
  fs.chmodSync(stateDir, 0o700);
} catch {}
```

(Import `fs`/`path` in index.js ergänzen — prüfen, ob schon vorhanden.)
Zusätzlich in `lib/social-memory.js` `ensureDir`: das recursive-mkdir
erzeugt Eltern (`state/social-memory` selbst) — nach dem mkdir ein
`fs.chmodSync(dirPath, 0o700)` existiert bereits; ergänze in
`scopeToPath`-Verwendern nichts. Das Startup-chmod deckt den Rest ab
(idempotent bei jedem Gateway-Start).

**Verify**: `npm test` → pass. Manuell im Worktree:
`node -e "…"`-Probe optional — statt dessen Test:

### Step 3: Test

Neuer Test (z.B. in `test/observed-store.test.js` oder
`test/register.test.js`, wo ein stateDir-Temp-Ordner leicht verfügbar ist):
register-ähnlicher Pfad nur wenn praktikabel; andernfalls Unit-Assert:

1. Log-Redaction: Fake-Log mit `warn`-Recorder, appendObserved mit
   ungültigem Pfad (stateDir zeigt auf eine Datei) → Warn-String enthält
   NICHT mehr als 4 aufeinanderfolgende Ziffern des Session-Keys
   (`/\d{5,}/` matcht nicht auf den redactierten Key).
2. Wenn ein register-Test existiert (`test/register.test.js`): stateDir
   (Temp) → nach `register()` `fs.statSync(stateDir).mode & 0o777` === 0o700.

**Verify**: `npm test` → all pass.

## Test plan

Siehe Step 3. Muster: bestehende Fake-Log-Recorder in
observed-store/social-memory-Tests.

## Done criteria

- [ ] `rg -n "error for \$\{sessionKey\}|for \$\{scope\}|to=\$\{to\}" lib/` → keine Treffer (redactiert)
- [ ] `npm test` exit 0
- [ ] `git status` nur In-Scope-Dateien
- [ ] `plans/README.md` Status-Row aktualisiert

## STOP conditions

- Excerpts/Zeilennummern passen nicht zu `c4e148b` (Zeilen können durch
  andere Wellen-Commits verschoben sein — Inhalt zählt; bei inhaltlichem
  Widerspruch STOP).
- Ein bestehender Test asserted den rohen Key im Log → melden (das wäre ein
  Test, der das Leak verankert).

## Maintenance notes

- Neue Log-Zeilen mit session/scope-Bezug: IMMER `redactSessionKey`. Der
  Reviewer prüft künftige Diffs darauf.
- Live-Maschine: nach Deploy einmalig `chmod 700 ~/human-engine/state
  ~/human-engine/state/social-memory` (Operator-Handgriff, nicht im Repo).
- Das Startup-chmod ist bewusst grob (alle Unterordner 0700) — Dateien
  bleiben 0600 durch die bestehenden write-Modes.
