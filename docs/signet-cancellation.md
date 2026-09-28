# Signet request cancellation

`SignetClient.post(action, body, onDispatch?, { signal? })` accepts caller cancellation without changing existing dispatch callbacks. `renew({ signal? })` also accepts cancellation. The allowed actions now include `verifyAuthority`; it carries an enrolled DPoP credential and cannot authenticate Kingdom's session-only caller or owner-management checks.

```ts
const observation = await client.post('verifyAuthority', request, undefined, {
  signal: controller.signal,
});
```

Each call has a maximum 20-second deadline across credential reads, renewal waiting, nonce acquisition, request dispatch and response reads. A caller abort is checked before dispatch, after the dispatch callback and after asynchronous boundaries. A stalled or late response cannot become a successful result after cancellation. Bodies retain the existing one-MiB bound and redirects remain refused.

Credential refresh is shared by credential-file path. Canceling one caller ends its wait and prevents its business request from dispatching; the bounded refresh may finish and persist refreshed credentials for another caller. Cancellation is not evidence that a request already received by the server was undone. Failed or uncertain business requests are never automatically retried.

An authority observation describes current permission facts. It is not human approval, source content, a quota reservation or admission to execute an experiment. Consumers must validate the shared Kingdom schema and their own exact request/identity constraints. Existing `execute` authorization and accounting remain the source dispatch boundary.

Focused verification: `bun test packages/foundry/tests/signet-cancellation.test.ts`. Tests use synthetic private credential files and a controlled fetch implementation; no provider or hosted Kingdom calls occur.
