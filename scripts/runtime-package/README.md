# Installed runtime extension verification

The public `@inixiative/foundry/runtime` entrypoint is for application-owned runtime handlers. `@inixiative/foundry/jobs` remains the BullMQ job module. This change exports existing implementations and types; it adds no job kind, authorization action, credential reader, model call or startup side effect.

The consumer test must run outside the monorepo, against installed tarballs. Packing matters: a sibling source import can pass while the package export map is unusable. Create a fresh temporary directory, then run from each package:

```sh
# Run in packages/core, then packages/foundry, with the same absolute directory.
bun pm pack --destination /absolute/temporary/consumer
```

In that temporary directory create this package manifest (update tarball versions when package versions change):

```json
{
  "name": "foundry-runtime-consumer-verification",
  "private": true,
  "type": "module",
  "dependencies": {
    "@inixiative/foundry": "file:./inixiative-foundry-0.1.0.tgz",
    "@inixiative/foundry-core": "file:./inixiative-foundry-core-0.1.0.tgz",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "@types/bun": "^1.4.2",
    "@types/node": "^25.5.2"
  }
}
```

Run `bun install --ignore-scripts`, copy `consumer.test.ts` there, and use this `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
    "strict": true, "noEmit": true, "skipLibCheck": true,
    "types": ["bun"], "allowImportingTsExtensions": true
  },
  "include": ["consumer.test.ts"]
}
```

Then run `bun test consumer.test.ts` and `bun x --no-install tsc --noEmit`. The runtime test verifies resolution inside the installed package, rejects deep imports, registers a typed custom handler, runs it through the real worker with a controlled transport and synthetic temporary credential, rejects an unknown kind, and stops without polling again. Global network access is replaced with a throwing function; neither enrollment nor real credentials are used. Typechecking verifies all exposed contracts and that the Signet action union has not widened.

Observed September 28: both consumer tests passed (22 assertions), and the external consumer typecheck passed. No package was published. Application-wide and live CLI suites were not run for this export-only change.
