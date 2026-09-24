# Session storage

Schema revision: 1.

Messages and traces are in memory. Native session bindings are persisted as JSON.
A restart preserves the binding but does not restore the message list or traces.

The application currently has no automatic checkpoint replay.
