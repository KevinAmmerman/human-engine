# Onboarding Multi-Tenant

Short, table-first runbook for adding a new **agent** or a new **WhatsApp
group / channel** to an existing agent. Everything here is declarative: profiles
+ files only, no code. Misconfiguration is caught loudly at startup by
`autoconfig` (advisory warnings — see [Environment](./environment.md)).

All paths below are illustrative placeholders — substitute your real paths.

## New AGENT

| # | Action | Where | Detail |
|---|--------|-------|--------|
| a | Create workspace files | your workspace | `contacts.md` (table: `\| @lid \| Telefonnummer \| Name \| Notizen \|`) and `SOUL.md` |
| b | Config: add agent | `plugins.entries["human-engine"].config` | agent ID into `agents` allowlist **and** an `agentProfiles[<id>]` entry (`agentName`, `agentAliases`, `contactsPath`, `soulPath`, optional feature overrides) |
| c | Gateway restart | operator | `openclaw gateway restart` |
| d | Verify | logs | autoconfig warnings empty for the ID; `decision=…` lines with the new `agent:<id>:…` sessionKey prefix; first hard-trigger reply lands in the target group |

The agent ID appears in the sessionKey as `agent:<id>:<channel>:…`. A profile
keyed by an ID not in `agents` is **inert** (autoconfig warns at startup).

## New WhatsApp GROUP / CHANNEL for an existing agent

| # | Action | Where | Detail |
|---|--------|-------|--------|
| a | Add group members | `channels.whatsapp.groupAllowFrom` | members outside this list are **silently dropped before any inbound log** (no ack, no session entry, no gate) |
| b | No plugin config needed | — | sessionKey derives from scope (no new profile) |
| c | Verify | logs | `message_received fired sk=agent:<id>:whatsapp:group:…` |

## Rollback / Kill-Switches

| Switch | Effect |
|--------|--------|
| `enabled: false` | everything no-ops, zero LLM calls |
| `proactive.enabled: false` | proactive funnel off |
| `dmProactive.enabled: false` + disable the Cron | DM-proactive lane off (Plan 536 kill-switch pattern) |
| remove the `agentProfiles[<id>]` entry | agent falls back to the global identity (byte-for-byte single-agent behavior) |

All code steps are backward-compatible: empty profiles = status quo ante.

## Shadow first-run for new agents

Run new agents/groups with `proactive.shadow: true` and
`dmProactive.shadow: true` **in the profile override** until log review is OK.
Shadow mode logs would-be sends without delivering — safe to observe.

## Live-Rollout (Operator)

Executor does NOT run this — the operator does AFTER merge. Backward-compatible:
every code step is safe to roll back by restoring the backup below.

1. `git -C ~/human-engine log --oneline -1` (wave complete) → `openclaw gateway
   restart` → grep the log for `human-engine:` startup errors.
2. Backup: `cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak.mt-$(date -u +%Y%m%d-%H%M%S)`.
3. First switch ONLY the Yuki profile (move global keys into the existing
   agent's profile; behavior must be IDENTICAL) + 24 h observation.
4. Then a second agent/group per the checklist above; shadow on.
5. Rollback: restore the backup or remove profile keys; empty profiles = status
   quo ante.
