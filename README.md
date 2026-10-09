# ask_user for Pi

A [Pi](https://pi.dev) extension that adds an `ask_user` tool. When an unresolved
choice would change user-visible behavior, scope, or the amount of rework, the
agent asks one question with 2–3 options and their tradeoffs (plus an optional
recommendation). The question appears in Pi's built-in `select` dialog, with a
last choice for typing a free-text answer.

The tool returns one of three statuses:

- `answered`: the user picked an option or typed a non-empty answer.
- `cancelled`: the user dismissed the dialog, submitted an empty answer, or the run was aborted.
- `unavailable`: there is no UI (print or JSON mode).

Only `answered` carries an answer. The full interface and asking policy are in
[docs/CONTRACT.md](docs/CONTRACT.md).

## Turning the extension on and off

Run these from the project folder.

| Goal | Command |
|---|---|
| One session only | `pi -e ./src/index.ts` (add `-e ./scripts/cap-max-tokens.ts` if your API key has a low spending limit). Plain `pi` then runs without it. |
| Always on | `pi install ./` |
| Off for good | `pi remove ./` |
| Toggle an installed copy without removing it | `pi config` (Tab switches personal/project scope) |
| Skip all extensions for one run | `pi -ne` |
| Pick up code edits inside a running Pi | `/reload` |

## Develop

Requires Node 24 (native TypeScript type stripping).

```bash
npm install
npm test            # node --test against the registered tool, with a fake dialog
npm run typecheck   # tsc --noEmit
```

## Batch test report

```bash
npm run test:batch
```

Runs every scenario in [`test/batch.ts`](test/batch.ts) (answered, cancelled,
unavailable, invalid input, unexpected dialog response, and dialog layout)
through the real registered tool with a fake dialog. It does not start Pi or
call a model. It prints one line per scenario and writes
[`test/batch-test/results.json`](test/batch-test/results.json) with each
scenario's input, simulated user action, the dialogs that opened (with their
choices), expected and actual results, and pass/fail. It exits 1 if any
scenario fails. It is separate from `npm test` so the JSON only changes when
you ask for a report.

## Live check (spends model credits)

```bash
node scripts/live-rpc-check.mjs
```

This starts `pi --mode rpc` with only this extension and the `ask_user` tool,
sends a task that leaves a design choice open, answers the forwarded dialog,
and prints the dialog request, the tool result, and the agent's final reply. It
also loads `scripts/cap-max-tokens.ts`, which lowers the requested max output
tokens so a spending-limited API key isn't rejected.

Recorded runs are in [docs/evidence/](docs/evidence/).
