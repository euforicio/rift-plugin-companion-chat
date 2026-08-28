# Companion Chat

A local bb extension for starting a fresh provider-selectable chat beside an
existing thread.

Open a thread's panel launcher and choose **Companion chat**. The panel uses
bb's native new-thread composer, defaults to the current project and worktree,
and lets you choose any installed provider and model. After submission, the
new thread runs in the panel with its own independent conversation and remains
available in bb's thread list when the panel closes.

Companion chats do not fork or copy the source provider session. They share the
selected environment, so file changes are immediately visible to every thread
using that worktree.

## Development

```bash
npm install
npm test
npm run typecheck
bb plugin build
```

## Installation

```bash
bb plugin install .
```

After changing source files, run `bb plugin reload companion-chat`.

## License

MIT
