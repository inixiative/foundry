# Reuse: Foundry (existing machinery to extend)

- Memory: scoped records (`thread | project | global`), pinned vs audit-only kinds; `FileMemory.publish`.
- Composition view: core `adapters/markdown-hierarchy.ts` + `prompts/instruction-settings.ts` compose every role and slot. Don't add a second instruction loader.
- Correction detection: core `src/feedback/correction.ts` (`detectCorrection`, `extractCorrections`, classify prompt, batched variant). Live capture and Oracle share it.
- Decisions: agent-session `ClaudePrimedSessions` (warm, primed Haiku). Don't spawn ad-hoc CLI calls.
- Settings: `ConfigStore` (JSON patch, edits in the audit log `audit.jsonl`); composition audit in `audit/` (`AuditLog`, `CompositionAuditor`); project agents `extends` a global agent.
- Fork/side-chat: `POST /api/threads/:id/fork`, the Foundry self-chat.
- `RuleCompiler.recompileOn` and `CorpusCompiler.ingestFromSignalBus` have no callers; they're deletion candidates, not things to wire. [FEEDBACK-LOOP §3]
