import { defineConfig } from '@inixiative/atlas/config';

const CORE = 'packages/core/src';
const FOUNDRY = 'packages/foundry/src';
const ACP = 'packages/acp/src';
const UI = `${FOUNDRY}/viewer/ui`;

export default defineConfig({
  include: ['packages/*/src/**/*.ts', `${UI}/*.js`, 'scripts/**/*.ts'],
  ignore: [
    '**/*.test.ts',
    '**/tests/**',
    '**/index.ts',
    '**/*.d.ts',
    `${UI}/vendor/**`, // third-party browser modules (preact, htm, signals)
    'scripts/runtime-package/**', // a packaging smoke consumer, not Foundry source
  ],
  stamp: [
    // ── @kind: structural globs (no capture). Files no rule classifies carry a
    // hand-written @kind; stamp never overwrites one.
    { include: '**/adapters/**', kind: 'adapter' },
    {
      include: `${FOUNDRY}/tools/**`,
      exclude: `${FOUNDRY}/tools/output-filters.ts`,
      kind: 'adapter',
    },
    { include: `${FOUNDRY}/tools/output-filters.ts`, kind: 'transformer' },
    { include: ['**/routes/**', '**/routes.ts'], kind: 'route' },
    { include: '**/handlers/**', exclude: '**/handlers/index.ts', kind: 'handler' },
    { include: '**/types.ts', kind: 'type' },
    {
      include: [
        '**/cli.ts',
        '**/*-cli.ts',
        `${FOUNDRY}/{start,setup,doctor}.ts`,
        `${FOUNDRY}/viewer/server.ts`,
        `${ACP}/agent.ts`,
        'scripts/*.ts',
        'scripts/{daemon,vcr}/*.ts',
        'scripts/evals/*.ts',
      ],
      exclude: ['scripts/vcr/shared.ts', 'scripts/evals/cost-weights.ts'],
      kind: 'entrypoint',
    },
    { include: `${FOUNDRY}/jobs/make*.ts`, kind: 'constructor', constructs: 'job handlers' },
    {
      include: [
        `${CORE}/{base-agent,classifier,router,executor,decider,clarifier}.ts`,
        `${FOUNDRY}/agents/{cartographer,librarian,herald,domain-librarian,planner}.ts`,
      ],
      kind: 'agent',
    },
    {
      include: `${FOUNDRY}/providers/{anthropic,openai,openai-compatible,gemini,native-text-provider,primed-decisions,subscription-decisions}.ts`,
      kind: 'provider',
    },
    { include: `${FOUNDRY}/classify/charters/*.ts`, kind: 'definition' },
    { include: `${UI}/store.js`, kind: 'store' },
    { include: `${UI}/app.js`, kind: 'entrypoint' },
    { include: `${UI}/{lib,route,hotkeys,dev-mode}.js`, kind: 'utils' },
    { include: `${UI}/{ws-client,data-stream-socket}.js`, kind: 'client' },
    {
      include: `${UI}/*.js`,
      exclude: `${UI}/{store,app,lib,route,hotkeys,dev-mode,ws-client,data-stream-socket}.js`,
      kind: 'component',
    },

    // ── @partOf: membership, by directory and by file. Rules compose, so a file
    // can be part of a feature and of the primitive it implements.

    // core primitives
    {
      include: `${CORE}/{base-agent,classifier,router,executor,decider,clarifier,harness}.ts`,
      partOf: 'primitive:agents',
    },
    { include: `${CORE}/{types,capability}.ts`, partOf: 'primitive:agents' },
    { include: `${CORE}/{thread,scope,id}.ts`, partOf: 'primitive:thread' },
    {
      include: `${CORE}/{context-layer,context-stack,cache-lifecycle,hydrator}.ts`,
      partOf: 'primitive:contextLayers',
    },
    { include: `${CORE}/{middleware,hooks,retry}.ts`, partOf: 'primitive:middleware' },
    {
      include: `${CORE}/{signal,event-stream,intervention,action-prompt,bounded-set}.ts`,
      partOf: 'primitive:signals',
    },
    { include: `${CORE}/trace.ts`, partOf: 'primitive:traces' },
    { include: `${CORE}/{tools,native-tools,capability}.ts`, partOf: 'primitive:tools' },
    { include: `${CORE}/model-registry.ts`, partOf: 'primitive:modelRegistry' },
    {
      include: `${CORE}/{session-delivery,messages,delivery-evidence,native-evidence}.ts`,
      partOf: 'primitive:nativeSessions',
    },
    { include: `${CORE}/{token-tracker,token-counts}.ts`, partOf: 'feature:usage' },
    { include: `${CORE}/credentials.ts`, partOf: 'primitive:secrets' },
    {
      include: `${CORE}/adapters/{file-memory,http-memory,sqlite-memory,markdown-docs}.ts`,
      partOf: 'primitive:memory',
    },
    { include: `${CORE}/adapters/markdown-hierarchy.ts`, partOf: 'feature:composition' },
    {
      include: `${CORE}/feedback/{correction,review-findings,archive-turns}.ts`,
      partOf: 'feature:feedback',
    },
    { include: `${CORE}/feedback/archive-turns.ts`, partOf: 'integration:archive' },
    {
      include: `${CORE}/feedback/{experiment-gate,warden-probes,warden-labels}.ts`,
      partOf: 'feature:evals',
    },
    { include: `${CORE}/feedback/warden-prefilter.ts`, partOf: 'feature:wardens' },

    // foundry: agents
    {
      include: `${FOUNDRY}/agents/{flow-orchestrator,cartographer,librarian,herald,workstream-detector,planner,reactive,builtin-hooks,corpus-compiler,learning-config,configured-experts}.ts`,
      partOf: 'feature:flow',
    },
    { include: `${FOUNDRY}/development-team.ts`, partOf: 'feature:flow' },
    {
      include: `${FOUNDRY}/agents/{domain-librarian,region-roster,warden-triggers,chorus-reception,work-items}.ts`,
      partOf: 'feature:wardens',
    },
    { include: `${FOUNDRY}/agents/configured-experts.ts`, partOf: 'feature:wardens' },
    {
      include: `${FOUNDRY}/agents/{thread-runtime,thread-factory,session,thread-namer,project}.ts`,
      partOf: 'feature:threads',
    },
    {
      include: `${FOUNDRY}/agents/role-layers.ts`,
      partOf: ['feature:composition', 'primitive:contextLayers'],
    },
    {
      include: `${FOUNDRY}/agents/{tool-loop,native-tool-projection}.ts`,
      partOf: 'primitive:tools',
    },
    { include: `${FOUNDRY}/agents/tool-loop.ts`, partOf: 'primitive:agents' },

    // foundry: the turn path
    { include: `${FOUNDRY}/turns/{turn-service,host-instructions}.ts`, partOf: 'feature:threads' },
    { include: `${FOUNDRY}/turns/tool-gate.ts`, partOf: 'feature:toolGate' },
    { include: `${FOUNDRY}/turns/subagents.ts`, partOf: 'feature:threadTree' },

    // foundry: classification and Wardens
    { include: `${FOUNDRY}/classify/**`, partOf: 'primitive:classify' },
    {
      include: `${FOUNDRY}/providers/{warden-prefilter,prefilter-model,in-session-wardens}.ts`,
      partOf: 'feature:wardens',
    },
    { include: `${FOUNDRY}/readiness.ts`, partOf: 'feature:wardens' },

    // foundry: feedback and evals
    {
      include: `${FOUNDRY}/feedback/**`,
      exclude: `${FOUNDRY}/feedback/{charter-eval,classify-run}.ts`,
      partOf: 'feature:feedback',
    },
    {
      include: [`${FOUNDRY}/feedback/{charter-eval,classify-run}.ts`, 'scripts/evals/**'],
      partOf: 'feature:evals',
    },
    { include: 'scripts/{measure-decisions,measure-warm-cache}.ts', partOf: 'feature:evals' },

    // foundry: providers, decisions, native sessions, logins
    {
      include: `${FOUNDRY}/providers/{anthropic,openai,openai-compatible,gemini,http-settlement,types}.ts`,
      partOf: 'primitive:providers',
    },
    {
      include: `${FOUNDRY}/providers/{subscription-decisions,decision-host,decision-budget,decision-priority,decision-provider,primed-decisions,subscription-policy}.ts`,
      partOf: 'primitive:decisions',
    },
    {
      include: `${FOUNDRY}/providers/{session-adapter,session-backed,session-delivery,native-text-provider,native-launch,native-evidence,native-text-environment,thread-launch}.ts`,
      partOf: 'primitive:nativeSessions',
    },
    {
      include: `${FOUNDRY}/providers/claude-context-budget.ts`,
      partOf: ['feature:usage', 'primitive:nativeSessions'],
    },
    {
      include: `${FOUNDRY}/providers/{native-authentication,subscription-authentication,kingdom-subscription-authentication,kingdom-subscription-login,provider-accounts,private-profile,default-profiles}.ts`,
      partOf: 'feature:nativeAuth',
    },
    { include: `${FOUNDRY}/providers/{kingdom-*,signet-cli}.ts`, partOf: 'integration:kingdom' },
    { include: `${FOUNDRY}/providers/kingdom-secrets.ts`, partOf: 'primitive:secrets' },
    {
      include: [
        `${FOUNDRY}/providers/typesafe*.ts`,
        `${FOUNDRY}/decisions/**`,
        'scripts/{typesafe-shadow,jev-catalog}.ts',
      ],
      partOf: 'integration:typesafe',
    },
    { include: `${FOUNDRY}/models/**`, partOf: 'primitive:modelRegistry' },
    {
      include: `${FOUNDRY}/startup-self-test.ts`,
      partOf: ['feature:setup', 'primitive:decisions'],
    },

    // foundry: Kingdom
    {
      include: [
        `${FOUNDRY}/kingdom/**`,
        `${FOUNDRY}/runtime/**`,
        `${FOUNDRY}/tools/kingdom-access.ts`,
      ],
      partOf: 'integration:kingdom',
    },
    { include: `${FOUNDRY}/viewer/{handoff,tunnel}.ts`, partOf: 'integration:kingdom' },
    {
      include: `${FOUNDRY}/viewer/routes/{kingdom,access,profile}.ts`,
      partOf: 'integration:kingdom',
    },

    // foundry: memory, tools, persistence
    { include: `${FOUNDRY}/adapters/**`, partOf: 'primitive:memory' },
    { include: `${FOUNDRY}/adapters/postgres-memory.ts`, partOf: 'infrastructure:prisma' },
    { include: `${FOUNDRY}/adapters/redis-memory.ts`, partOf: 'infrastructure:redis' },
    {
      include: `${FOUNDRY}/tools/**`,
      exclude: `${FOUNDRY}/tools/kingdom-access.ts`,
      partOf: 'primitive:tools',
    },
    { include: `${FOUNDRY}/tools/memory-adapter.ts`, partOf: 'primitive:memory' },
    {
      include: `${FOUNDRY}/persistence/{journal-content,local-session-store,image-attachments}.ts`,
      partOf: 'primitive:journal',
    },
    { include: `${FOUNDRY}/persistence/local-session-store.ts`, partOf: 'feature:threads' },
    {
      include: `${FOUNDRY}/persistence/knowledge-persistence.ts`,
      partOf: ['primitive:journal', 'primitive:memory'],
    },
    {
      include: `${FOUNDRY}/persistence/{trace-record,checkpoint-import}.ts`,
      partOf: 'primitive:traces',
    },
    { include: `${FOUNDRY}/persistence/prisma-json.ts`, partOf: 'infrastructure:prisma' },
    { include: `${FOUNDRY}/audit/**`, partOf: 'feature:auditLog' },
    { include: `${FOUNDRY}/audit/compositions.ts`, partOf: 'feature:composition' },
    { include: `${FOUNDRY}/prompts/**`, partOf: 'feature:composition' },

    // foundry: infrastructure primitives
    { include: `${FOUNDRY}/jobs/**`, partOf: 'primitive:jobs' },
    { include: `${FOUNDRY}/jobs/queue.ts`, partOf: 'infrastructure:redis' },
    {
      include: `${FOUNDRY}/jobs/handlers/{persistTrace,cleanStaleTraces}.ts`,
      partOf: 'primitive:traces',
    },
    { include: `${FOUNDRY}/jobs/handlers/persistSignal.ts`, partOf: 'primitive:signals' },
    { include: `${FOUNDRY}/jobs/handlers/warmLayers.ts`, partOf: 'primitive:contextLayers' },
    { include: `${FOUNDRY}/logger/**`, partOf: 'primitive:logger' },
    { include: `${FOUNDRY}/ws/**`, partOf: 'primitive:websockets' },
    { include: `${FOUNDRY}/client/data-stream-client.ts`, partOf: 'primitive:websockets' },
    { include: [`${FOUNDRY}/vcr/**`, 'scripts/vcr/**'], partOf: 'primitive:vcr' },
    { include: `${FOUNDRY}/git/**`, partOf: 'infrastructure:git' },
    { include: `${FOUNDRY}/client/private-file.ts`, partOf: 'primitive:secrets' },
    { include: `${FOUNDRY}/viewer/private-token.ts`, partOf: 'primitive:secrets' },

    // foundry: the MCP bridge, archives, setup, daemon, devices
    { include: `${FOUNDRY}/mcp/**`, partOf: 'feature:mcpBridge' },
    { include: `${FOUNDRY}/archives/**`, partOf: 'integration:archive' },
    { include: `${FOUNDRY}/archives/reduced-middleware.ts`, partOf: 'feature:threadTree' },
    { include: [`${FOUNDRY}/{setup,doctor}.ts`, `${FOUNDRY}/setup/**`], partOf: 'feature:setup' },
    {
      include: [
        `${FOUNDRY}/daemon/**`,
        `${FOUNDRY}/client/{daemon,launch}.ts`,
        'scripts/daemon/**',
      ],
      partOf: 'feature:daemon',
    },
    { include: [`${FOUNDRY}/client/foundry-client.ts`], partOf: 'feature:threads' },
    {
      include: [`${FOUNDRY}/devices/**`, `${FOUNDRY}/viewer/routes/devices.ts`],
      partOf: 'feature:devices',
    },
    { include: `${FOUNDRY}/cli.ts`, partOf: 'feature:setup' },
    { include: `${FOUNDRY}/start.ts`, partOf: ['feature:daemon', 'feature:flow'] },

    // foundry: the viewer (server side and browser UI)
    {
      include: `${FOUNDRY}/viewer/**`,
      exclude: `${FOUNDRY}/viewer/gloss/**`,
      partOf: 'feature:viewer',
    },
    {
      include: `${FOUNDRY}/viewer/{config,config-resolve,actions}.ts`,
      partOf: 'primitive:settings',
    },
    {
      include: `${FOUNDRY}/viewer/routes/{control,models,runtime}.ts`,
      partOf: 'primitive:settings',
    },
    { include: 'scripts/daemon/last-good.ts', partOf: 'primitive:settings' },
    { include: `${FOUNDRY}/viewer/analytics.ts`, partOf: 'feature:usage' },
    {
      include: `${FOUNDRY}/viewer/{data-streams,stream-buffer}.ts`,
      partOf: 'primitive:websockets',
    },
    {
      include: `${FOUNDRY}/viewer/{thread-directory,turn-flow,foundry-self-chat}.ts`,
      partOf: 'feature:threads',
    },
    {
      include: [
        `${FOUNDRY}/viewer/gloss/**`,
        `${FOUNDRY}/viewer/routes/gloss.ts`,
        `${UI}/gloss.js`,
        'scripts/gloss-*.ts',
      ],
      partOf: 'integration:gloss',
    },
    {
      include: `${UI}/{kingdom-settings,kingdom-holder,access-settings,integration-settings,profile-settings}.js`,
      partOf: 'integration:kingdom',
    },
    { include: `${UI}/{archive-settings,hosted-archive-link}.js`, partOf: 'integration:archive' },
    { include: `${UI}/{feedback}.js`, partOf: 'feature:feedback' },
    { include: `${UI}/devices.js`, partOf: 'feature:devices' },
    { include: `${UI}/analytics.js`, partOf: 'feature:usage' },
    { include: `${UI}/{settings,provider-settings,wizard}.js`, partOf: 'primitive:settings' },
    {
      include: `${UI}/{ws-client,data-stream-socket,live-state}.js`,
      partOf: 'primitive:websockets',
    },
    {
      include: `${UI}/{conversation,conversation-state,thread-labels,project-sidebar,self-chat,image-attachments}.js`,
      partOf: 'feature:threads',
    },
    { include: `${UI}/{thread-tree}.js`, partOf: 'feature:threadTree' },
    {
      include: `${UI}/{flow-graph,graph-view,layer-band,inspector-data,runtime-panels}.js`,
      partOf: 'feature:flow',
    },
    { include: `${UI}/delivery-evidence.js`, partOf: 'primitive:nativeSessions' },

    // foundry-acp
    { include: `${ACP}/**`, partOf: 'feature:acp' },
    { include: `${ACP}/guard.ts`, partOf: 'feature:wardens' },
  ],
  references: {
    docs: (v) => `docs/${v}`,
  },
});
