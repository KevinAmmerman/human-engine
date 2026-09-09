# Plan 013: Observed-Store Tail-Read — Decide-Pfad liest nur die letzten Zeilen statt der ganzen Datei

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git -C ~/human-engine diff --stat c4e148b..HEAD -- lib/observed-store.js test/observed-store.test.js`
> On mismatch with the "Current state" excerpt: STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (nur Lesepfad; Schreib-/Rotationslogik unverändert)
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `c4e148b`, 2026-09-09

## Why this matters

`readObserved(sk, 20)` läuft bei JEDER Gruppendecide synchron inline
(gate.js:113) und liest + JSON.parst derzeit die GESAMTE Session-Datei (bis
400 Zeilen nach MAX_LINES; die Live-Kletter-Datei ist schon 332 Zeilen /
51 KB) — pro Nachricht in einer aktiven Gruppe. Der Verbraucher will nur die
letzten 20 Zeilen. Fix: nur die letzten `last` Zeilen parsen plus ein
kurzer mtime/size-Cache, damit aufeinanderfolgende Decides innerhalb
derselben Datei-Version den Read nicht wiederholen.

## Current state

`lib/observed-store.js:67-91` (bei `c4e148b`):

```js
function readObserved(sessionKey, last = 20) {
  try {
    const file = fileFor(sessionKey);
    const raw = fs.readFileSync(file, "utf8");
    const out = [];
    const lines = raw.split("\n");
    for (const line of lines) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        if (row && typeof row.text === "string") {
          out.push({ speaker: typeof row.speaker === "string" ? row.speaker : "", text: row.text, ts: row.ts });
        }
      } catch {
        _log.warn(`human-engine: observed-store: skipping corrupt line in ${sessionKey}: ...`);
      }
    }
    return out.slice(-Math.max(1, last));
  } catch (err { ... return []; }
}
```

`lineCount`-Map (Z. 14) existiert bereits (append-Pfad). Aufrufer:
`gate.js:113` `observedStore.readObserved(sk, 20)` in `resolveTranscript`
vor JEDER Decide. Rotation: 400 → 200 Zeilen (MAX_LINES/KEEP_LINES, Z. 4-5).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Unit | `node --test test/observed-store.test.js` | all pass |
| Tests | `npm test` | all pass, 0 fail |

## Scope

**In scope**:
- `lib/observed-store.js` (nur `readObserved`)
- `test/observed-store.test.js` (neue Cases)

**Out of scope**:
- `appendObserved`, `rotate`, `countLines`, `lineCount` (Schreibpfad)
- `lib/gate.js` (Aufrufer bleibt `readObserved(sk, 20)`)
- Parity-Matrix (keine Verhaltensänderung)

## Git workflow

- Branch: `advisor/013-observed-tail-read`
- 1 Commit; Stil `plan 013: …`

## Steps

### Step 1: Nur die letzten Zeilen parsen

Ersetze den Parse-Loop: erst `lines = raw.split("\n")`, dann
`const tail = lines.slice(-Math.max(1, last) * 2)` (Faktor 2 Puffer für
leere/korrupte Zeilen), dann JSON.parse nur über `tail`. Output bleibt
`out.slice(-last)`. Korrupte Zeilen werden weiterhin gewarnt (mit
redactiertem Key — Plan 012 sollte gelandet sein; falls nicht: redact
hier gleich mitführen).

**Verify**: `node --test test/observed-store.test.js` → pass.

### Step 2: mtime/size-Cache

Im Factory-Closure:

```js
const readCache = new Map(); // file -> { mtimeMs, size, out }
// in readObserved:
let st = null;
try { st = fs.statSync(file); } catch { return []; }
const hit = readCache.get(file);
if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.out.slice(-last);
// ... normaler Read wie Step 1, dann:
readCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, out });
if (readCache.size > 128) readCache.delete(readCache.keys().next().value);
```

Der Cache speichert die geparsten letzten ~40 Zeilen (bereits tail-gekappt
auf `last*2` beim Befüll-Read — cache `out` VOR dem slice(-last), damit
andere `last`-Werte vom Cache profitieren). Achtung Rotation: nach rotate
ändern sich mtime+size → Cache invalidated automatisch.

**Verify**: `node --test test/observed-store.test.js` → pass; `npm test`.

### Step 3: Tests

1. Datei mit 400 Zeilen: `readObserved(sk, 20)` → 20 Einträge, und zwar die
   LETZTEN 20 (Reihenfolge + ts prüfen).
2. Korrupte Zeile am Ende: wird geskippt, davor/danach normal (Puffer-Faktor
   greift: 2 korrupte unter den letzten 20 → ältere rutschen rein? Nein —
   Puffer `last*2` erlaubt bis zu `last` korrupte Zeilen; Test: 3 korrupte
   Zeilen in den letzten 25 → trotzdem 20 valide Einträge).
3. Cache: zweiter Read ohne Append → identisches Ergebnis; nach
   `appendObserved` → neuer Eintrag sichtbar (Cache invalidiert).
4. Rotation danach: Read liefert die rotierten (gekappten) Daten korrekt.

**Verify**: `npm test` → all pass.

## Test plan

Siehe Step 3. Muster: bestehende observed-store-Tests (Temp-Dirs, Fake-Log).

## Done criteria

- [ ] `npm test` exit 0 inkl. neuer Cases
- [ ] `grep -n "for (const line of lines)" lib/observed-store.js` → nur noch im tail-Block
- [ ] `git status` nur In-Scope-Dateien
- [ ] `plans/README.md` Status-Row aktualisiert

## STOP conditions

- Excerpt passt nicht zu `c4e148b`.
- Ein bestehender Rotation-/Append-Test bricht (Cache hält Stale-Daten über
  Rotation hinweg) → melden; nicht mit sleep/force-invalidate improvisieren,
  sondern Rotation-Pfad um Cache-Delete ergänzen und erneut prüfen.

## Maintenance notes

- Der Cache ist prozess-lokal; `gateway_stop` muss ihn nicht clearen
  (ephemeral). Bei künftigem Multi-Process-Zugriff auf state/observed wäre
  der mtime/size-Key weiterhin korrekt.
- Plan 021 (Recall) und 022 (Thread-Rebuild) lesen observed ebenfalls —
  dort `readObserved` wiederverwenden statt eigene Reads zu bauen.
