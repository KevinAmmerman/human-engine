# Changelog

## 0.2.0 — renamed to human-engine, fully local engine

- Renamed from `humalike` to `human-engine`.
- Humalike transport removed; all logic runs via the host's built-in LLM.
- New config path: `plugins.entries["human-engine"].config.*`.
- Fully self-hosted, no external API dependencies.

## 0.1.0 — initial Humalike-API port

- Initial port of the Hermes humalike plugin behavioral concepts.
- Turn-taking gate, bubble naturalization, voice card, social memory.
