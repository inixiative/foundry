# Ship: Foundry

- Agentic lane: merge yourself once green. Releases go through the agentic train. A failed Foundry check stops the whole train.
- The daemon runs from the shared main checkout `~/code/inixiative/foundry` (port 4500 from the registry). Never commit there. A restart and a live-settings edit are separate, explicit steps. Never hand-edit `.foundry/releases/state.json`. [COORDINATION]
- Live `.foundry/settings.json` changes need a backup (`settings.json.bak-<what>-<ts>`) and a note in COORDINATION. [COORDINATION pattern]
