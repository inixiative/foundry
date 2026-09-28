# Task settlement

`SignetClient.post("settleTask", request, onDispatch, { signal })` posts the generic Kingdom task-settlement request with an endpoint- and token-bound DPoP proof. The consumer supplies and validates its shared request/receipt schemas.

Settlement uses the existing credential file and an unexpired access token, including tokens within the usual 30-second renewal window. It never renews, waits on another renewal, or retries a business request automatically. A caller may reconcile an uncertain response by explicitly submitting the same request ID and full body; each attempt obtains a fresh proof. The server returns its original immutable receipt or refuses the replay. An expired token fails before any network request.

A timeout or cancellation after dispatch does not prove the server rolled back. Keep output withheld until all exact required settlement receipts are verified. Receipt replay is historical metadata: it does not reopen task access or extend the original delivery deadline. Local consent, recipient and one-use publication checks remain the application's responsibility.
