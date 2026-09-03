# Social Memory v2 — Schema- und Recall-Redesign (SPIKE)

## Kontext / Problem

Memory ist die per-Person-Unabhängigkeit, die der Owner explizit will — heute
ist sie aber ein CRM-Dump. Schema ist nur `facts/preferences/situation`
(`local-prompts.js`); Recall ist top-3-nach-lastSeen + involvierte Namen, hart
bei 800 Zeichen (`social-memory.js`). Der Agent wird als (leere) Person
mitgeführt. Was einen Gruppen-Menschen „menschlich" macht, ist NICHT
Fakten-Recall, sondern Beziehungs-Textur: running jokes, Teasing-Stil pro
Person, offene Threads, emotionale Kontexte. Dafür gibt es heute keinen Platz
im Schema.

## 1. Schema v2 (pro Person)

Alte Felder bleiben, neue kommen dazu. Kapselung in `getOrLoadProfile`.

- `facts` — Array, Cap 12. Nur durable Fakten; roher Smalltalk wird verworfen.
- `preferences` — Array, Cap 6.
- `situation` — String, unverändert.
- `relationship` — NEU, String, 1–2 Sätze. Wie wir interagieren: Teasing-Stil,
  Vertrauenslevel, Grenzen. Extrahiert nur aus beobachtetem Dialog, nie
  synthetisiert.
- `open_threads` — NEU, Array von `{topic, lastExchange, whoOwesWhat}`, Cap 3.
- `emotional_state` — NEU, String, Cap 1 Satz, kurzlebig, mit `updatedAtTs`.
- `lastSeenTs` / `mentionCount` — Metadaten, unverändert.

## 2. Self-Filter

Der `people`-Map entfallen `cfg.agentName` + alle `agentAliases`
(case-insensitive):

- beim `ingest`: kein Person-Record für den Agent-Speaker anlegen/updaten;
- bei der Merge-Normalisierung in `getOrLoadProfile`: bestehende Selbst-Records
  aus dem Recall ausschließen (NICHT von Disk löschen; der nächste Extract-Merge
  droppt sie, weil die LLM den Namen nicht mehr sieht — bis zur maxPeople-Eviction
  bleibt er auf Disk stehen, dokumentiert).

## 3. Recall v2 (Design only)

Relevanz = f(involvement, recency, offene Threads, current-topic-overlap via
bestehendem `overlapCount`). Ausgabe als kurze Sektionen, ≤ 800 Zeichen,
niemals über gespeicherte Strings hinaus erfinden. Keine Recall-Rewrite in
diesem Spike.

## 4. Callback-Kanal (Design only)

Memory-Einträge mit Flag `callbackWorthy` laufen durch den proaktiven Funnel
(nicht den reaktiven Pfad). Eine Trigger-Idee: offener Thread mit
`whoOwesWhat` auf den Agent und verfallendem `lastExchange`. Anti-Annoyance:
Wiederverwendung des bestehenden Care-/Cooldown-Mechanismus.

## 5. Migration

Alte Profile laden als v2 mit leeren neuen Feldern (Normalisierung in
`getOrLoadProfile`). Keine Disk-Migration nötig. Operator-Schritt (falls
gewünscht): manuelles Entfernen des Selbst-Records aus Live-State-Dateien.

## 6. Risiken

- **Halluzinierte Beziehungen**: `relationship` ist extract-only aus
  beobachtetem Dialog, nie synthetisiert.
- **Token-Budget**: neue Felder erhöhen die Extract-Prompt; Caps oben.
- **PII**: alle Felder bleiben in 0600-State-Dateien; Redaction-Regeln aus
  Plan 503 gelten für jede neue Log-Ausgabe.

## Out of Scope (Follow-up)

Wire `buildMemoryExtractPromptV2` hinter `socialMemory.schemaV2: true`,
Recall-Rewrite nach §3, Callback-Trigger nach §4. Erst nach Operator-Review
dieses Designs.
