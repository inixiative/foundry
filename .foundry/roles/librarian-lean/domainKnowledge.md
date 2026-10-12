# Lean: Foundry

- No backwards-compat cruft: remove unused systems entirely. No optional fallbacks, no re-exported removed types, no `_unused` vars. [foundry CLAUDE.md principle 5]
- Supervised mode, foundry-lab, `native-candidate`, the medical demo, the Kingdom runtime-job worker and the runtime key are gone. Never reintroduce them. [org CLAUDE.md]
- Don't add a summarizer or compression loop; use Claude Code's native auto-compaction. [foundry CLAUDE.md]
