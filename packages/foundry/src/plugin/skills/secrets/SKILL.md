---
name: secrets
description: Use in a Foundry thread when a message holds a reference like †<message>.<n> (a secret the person handed you as $$word), when you need a credential put into an env file or a command, or when a read is refused because a path is private. Covers using secrets without reading them.
---

# Secrets

The person hands you a secret by writing `$$` before it. Foundry lifts it out of the message before you, the journal or Archive see it, keeps it in the thread's scratch pad, and leaves a reference in its place: `†<message>.<n>` (another thread's is `†<thread>/<message>.<n>`). You never see the value. Use it; never try to read it.

## Use it

1. **Put it in an env file** (the normal path): `secret_scratch` with `action: "env"`, the `ref`, the file (`.env.local`) and the `key`. Pass `consume: true` when that is its last use.
2. **Hand it to a command**: `secret_pipe` with `envFile` and `key` (or a `ref`) and a `command` that reads stdin: `gh secret set API_TOKEN`, `railway variables set API_TOKEN --stdin`, `vercel env add API_TOKEN production`. The output is thrown away; only the exit code comes back. A failed command keeps the secret.
3. **Put it in a file** (a key file): `secret_scratch` with `action: "write"` and the `path`.
4. **See what is pending**: `secret_scratch` with `action: "list"` (this thread), `thread` (another), or `all: true`. You get references and the message each came from, never values. A leftover from an old thread can be used with its full reference.

## Limits

- `secret_scratch` writes only inside the thread's working directory, never into `.git`, `.claude`, `.ssh` or agent settings. For anywhere else, use `secret_pipe` with a command, which asks the person when the host would.
- Secrets are used only in a turn the person's own message opened. A turn that carries someone else's words (a member's post in a shared thread) can't use them.
- Another thread's pad is reachable only from a thread of the same project. A pad is deleted when its thread is archived.

## Don't

- Read, search, `cat`, `grep` or print the scratch pad, a file named `.private`, `*.private` or `*.private.*`, or any file the pad wrote to. Use `secret_pipe` from that file instead. On Claude, Foundry refuses calls that name them; it matches names, not what a command does, and on other workers it may not see the call at all, so this rule is yours to keep.
- Copy a secret somewhere you will read it later, or echo it in a command's arguments.
- Ask the person to paste a secret in plain text: ask them to send it as `$$value`.
