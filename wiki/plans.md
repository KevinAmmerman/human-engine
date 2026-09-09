# Plans

Improve-skill wave: **Multi-Tenancy** (generated 2026-09-09, executed same
day). Goal: add agents and WhatsApp groups/channels declaratively — own
personality, own contacts, own social cards, own budgets, everything
isolated per agent and per channel. All plans executed via executor
subagents and advisor-reviewed; wave merged to main and deployed.

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| [001](../plans/001-canonical-scope-parser.md) | Kanonischer Session-Scope-Parser (`lib/scope.js`) | P1 | M | — | DONE |
| [002](../plans/002-agent-profiles-config.md) | Per-Agent-Config-Profile (`agentProfiles` + Resolver + Schema) | P1 | M | 001 | DONE |
| [003](../plans/003-per-agent-identity.md) | Identity-Consumer pro Agent (Name/Aliases/Contacts/Soul/Self-Filter) | P1 | L | 001, 002 | DONE |
| [004](../plans/004-social-cards-per-agent.md) | Social Cards pro Agent (Voice-Card-Cache v2, per-agent Eviction) | P1 | M | 002, 003 | DONE |
| [005](../plans/005-proactive-tenancy.md) | Proactive/DM-Proactive-State pro Agent + `dmProactive.agents` + DayFit-Pfad | P1 | L | 001, 002, 003 | DONE |
| [006](../plans/006-onboarding-hardening.md) | Onboarding-Runbook + Autoconfig-Validierung + Vertrags-Matrix + Rollout-Checkliste | P2 | M | 001–005 | DONE |
| [007](../plans/007-fallback-filter-agent-run-failed.md) | Fallback-Filter: „⚠️ Agent run failed" nie capturen (Prod-Incident) | P1 | S | — | DONE |
| [008](../plans/008-llm-caller-agentid.md) | `agentId` an alle llm.complete-Calls (korrektes Routing/Audit) | P2 | M | 001/003 | DONE |

Status breakdown: 8 DONE, 0 TODO, 0 BLOCKED.

## Notes

- Test growth across the wave: 915 → 921 pass (plus E2E anchors:
  multi-agent pipeline, social-card isolation, proactive tenancy,
  onboarding, agent-run-failed suppression).
- Parity matrix: 51 → 56 rows (rows 52–56 are the multi-tenancy contract).
- Known host-side issue NOT covered here: agent runs can fail with
  „Session transcript keyed user is outside the current turn" (OpenClaw
  core; pre-dates the wave). The plugin handles the failure safely since
  Plan 007 (silent no-reply instead of leaking error text).
- Onboarding for the next agent/group: see
  [operations/onboarding-multi-tenant.md](./operations/onboarding-multi-tenant.md).
