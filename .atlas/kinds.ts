import { DEFAULT_KINDS } from '@inixiative/atlas';

// atlas's defaults cover most of Foundry's roles; two more:
// 'agent'    = a named agent role (the FLOW.md roles and core's agent shapes: Cartographer,
//              Librarian, Herald, a Warden, classifier, router, executor)
// 'provider' = an LLM provider: an API-key provider or a native-session / decision provider
export const KINDS = [...DEFAULT_KINDS, 'agent', 'provider'] as const;
