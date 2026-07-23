# Human Review Protocol — Local Human Engine

## Purpose

Before enabling Humalike on a live group, an operator must review generated
outputs to confirm they are **human-plausible**. This document provides a
10-step checklist covering output quality, tell detection, and timing
believability. Every rubric item traces to a research benchmark.

## Prerequisites

- Humalike local engine installed and configured.
- A test channel/group (anonymized for review).
- Real LLM configured (decide + humanize models).
- `npm test` passes (244+ tests).
- `node test/parity-matrix.mjs --check` → `32/32 covered`.

---

## Step 1 — Run live decide eval

```bash
node scripts/decide-eval-live.mjs
```

- [ ] All 20+ scenarios pass (no unexpected SPEAK when STAY_SILENT expected).
- [ ] If failures exist, note which categories struggle: side chatter? answered
  questions? off-topic?

> Tracer: row #28 (DM/media/trigger short-circuits) must be 100%.

## Step 2 — Generate 20 bubble sets from real conversations

Use 5 real (anonymized) group scenarios. Capture the raw draft + the
split-prompt output. Save to a review log.

```bash
# Example — collect 5 transcripts with 4 replies each = 20 bubbles
```

- [ ] At least 20 bubble sets collected.
- [ ] Raw drafts preserved alongside split output.

## Step 3 — Eyeball each bubble set against the length rubric

Research says median human message is **15–30 chars**.

- [ ] Bubbles are 1–5 per reply (row #13).
- [ ] Each bubble ≤ 400 chars (row #13).
- [ ] Median bubble length is in the 15–30 char range.
- [ ] First bubble is often a pure reaction ("lol", "nice", "ja genau") —
  not a full sentence (row #29).

## Step 4 — Check register match

The output should match the group's tone (research: style-stats injection,
row #30).

- [ ] Casing matches group (lowercase group → lowercase output).
- [ ] Contraction rate matches group (heavy-contraction group → contractions).
- [ ] Emoji usage matches group (emoji-heavy group → some emoji in output).
- [ ] No sudden register shift between bubbles in the same reply.

## Step 5 — Tell scan

Run the tell detector across all 20 bubble sets and the raw drafts.

```bash
# In node:
# import { detectTells } from './lib/anti-tell.js'
# for each bubble set: detectTells(text)
```

- [ ] 0 em-dashes (row #29).
- [ ] 0 bullet/numbered lists.
- [ ] 0 bold markdown (`**`).
- [ ] 0 banned lexicon words (delve, tapestry, leverage, etc.).
- [ ] 0 summary closings ("In conclusion", "To summarize", "Overall").
- [ ] 0 enumeration ("Firstly", "Secondly", "Moreover").
- [ ] 0 "It's not X, it's Y" pattern.
- [ ] 0 "Not only... but also" pattern.
- [ ] 0 customer-service phrases ("How can I help you?").
- [ ] 0 "Certainly!" exclamations.

## Step 6 — Check timing feels right

Research benchmarks:
- Reading delay: 2000–30000 ms (row #26), median ~4000 ms.
- Think pause: 1000–5000 ms, median ~2500 ms.
- Typing: ~38–40 WPM (row #27).
- Bubble gap: 800–3000 ms (row #26).
- Night mode: 1.4× multiplier (row #27).
- Addressed: 0.5× reading multiplier.
- Unaddressed group: 1.5× reading multiplier.

- [ ] First bubble delay feels human (not instant, not absurdly long).
- [ ] Consecutive bubbles have gaps ≥ 800 ms.
- [ ] Timing varies noticeably between replies (CV > 0.15).
- [ ] Night messages are visibly slower than day messages.

## Step 7 — Verify the decide turn-taking

- [ ] DM always triggers speak (row #28).
- [ ] Media always triggers speak (row #28).
- [ ] Side chatter between two humans → stay_silent.
- [ ] Already-answered questions → stay_silent.
- [ ] Bot mentioned by name → speak (row #28).
- [ ] Bot spoke last turn, another member acknowledges → stay_silent.

## Step 8 — Test edge cases

- [ ] Bot sees an LLM error → single-bubble draft fallback (row #14).
- [ ] Bot's epoch is superseded → old bubbles cancelled (row #12).
- [ ] Group with `enabled: false` → no LLM calls, handlers no-op (row #22).
- [ ] Group with agent scoping `agents:["other"]` → bot untouched (row #23).

## Step 9 — Sign off or file findings

- [ ] All checks pass → sign off below and proceed to live enable.
- [ ] Any failures → file findings and review before re-testing.

**Sign off (operator):**
```
Date: _______________
Operator: ___________
Findings: ___________
Decision: [APPROVED] / [REVISE]
```

## Step 10 — Post-enable monitoring

For the first 48 hours of live operation:

- Monitor `humalike` log for unexpected stay_silent or spammy speak.
- Check that bubble timing feels natural to group members (no complaints).
- Re-run tell detector on 50 random live bubbles after 24h.

---

## Rubric traceability

| Rubric item | Research / Plan reference |
|---|---|
| 1–5 bubbles per reply | Row #13 |
| ≤ 400 chars per bubble | Row #13 |
| Median 15–30 chars | Research median human message length |
| First bubble may be pure reaction | Row #29 (anti-tell) |
| Register matches group | Row #30 (style-stats) |
| CV > 0.15 | Row #26 |
| Em-dash / list / bold markdown absent | Row #29 (anti-tell) |
| DM/media → speak (short-circuit) | Row #28 |
| Engine error → draft fallback | Row #14 |
| Supersede cancels bubbles | Row #12 |
| Kill-switch no-ops | Row #22 |
| Agent scoping | Row #23 |
| Timing ranges (2000–30000, 1000–5000, 800–3000) | Row #26 |
| Night mode 1.4× | Row #27 |
