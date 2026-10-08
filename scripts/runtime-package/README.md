# Verifying the published seam

`@inixiative/foundry/runtime` is the entrypoint outside consumers import. Everything in this repo resolves through the workspace, so an export can be broken for an installed consumer — a missing file in `files`, a type that only resolves through a path alias, an internal that is reachable when it should not be — and every in-repo test still passes.

`consumer.test.ts` runs against the packed package instead:

```sh
bun pm pack --cwd packages/foundry --destination /tmp/foundry-pack
mkdir -p /tmp/foundry-consumer && cd /tmp/foundry-consumer
bun init -y
bun add /tmp/foundry-pack/inixiative-foundry-*.tgz
cp <repo>/scripts/runtime-package/consumer.test.ts .
bun test
```

It checks four things, each a failure that in-repo tests cannot see:

- the seam exports exactly its named set, so a new export is a decision rather than a side effect of moving a file;
- importing it reaches no network, and resolves inside `node_modules` rather than to repo source;
- internals are not importable;
- the published settings schema parses a real settings object and refuses a relative credential path.

`tsconfig.json` excludes this directory, because `@inixiative/foundry/runtime` deliberately does not resolve from inside the repo — that is the condition the test exists to check, and typechecking it here would only ever fail.

It deliberately does not exercise a live pairing. Holding a Signet needs a Kingdom, an approved Installation and a credential file; that belongs in the live tests, not in a packaging check.
