Privately: nothing further is needed. The correction is verified, the stable G5 and baseline reports exist after the last source edit, and the handoff is written. Report follows.

The native model propagation correction is complete and verified. Not self-accepted; it returns for Astra's read-only review and supervisor acceptance.

## Verification

| Check | Result |
|---|---|
| Supervisor file before edits | 3 fail, 1 pass |
| Supervisor file via G5, unchanged | 4 pass, typecheck, diff check |
| My offline adapter and provider tests | 6 pass |
| Existing provider, adapter, providers, agent-selection, failure and session suites | 81 pass |
| Full baseline | pass |
| Foundry and core typecheck | exit 0 |

Reports: `.foundry/qa/2026-09-07T03-27-16.803Z-G5/report.json` and `.foundry/qa/2026-09-07T03-26-59.905Z-baseline/report.json`. Handoff: `fixtures/harness-qa/QA-2026-09-07-fable-native-model-profile.md`. One earlier baseline at 03:25 failed on my own then-wrong test and is retained as evidence.

## What changed

- **Both adapters** now pass the requested model into the engine. Claude emits it as `--model` argv; Codex sends it in the first native `codex` call arguments. Absent falls back to the adapter default. Text-only enforcement, restricted spawn flags, maxTurns, resume binding and signal bridging are unchanged.
- **The provider** computes the effective model, passes it to session creation, and records it in a frozen warm profile exposed read-only. A different model, tools mode or turn bound on a warm thread is refused before send, with the exact differences and the action to take. Identical explicit and default profiles reuse the session. The slot is reserved synchronously, so a concurrent different-profile request is refused rather than raced. Result `model` is the requested model; an engine-emitted label surfaces separately as `nativeModel`.
- **Resumed bindings** report model identity as unknown, since the store never recorded a model. Nothing was started fresh or replaced.

## Limitations

- Requested is not acknowledged. The installed engine does not retain the Claude init line, so the printed model label is unobservable through this provider until the sibling's unattributed-event retention is integrated. Tests prove argv and first-call configuration only.
- Out of scope and untouched: model catalog, execution-budget UI, the startup raw-provider fallback, stale generated knowledge and self-referential audit selection. No time remained for a read-only cause investigation of the last two.
- One of my six tests first encoded a wrong assumption about init retention and was corrected after inspecting the installed engine source. This is recorded in the handoff.