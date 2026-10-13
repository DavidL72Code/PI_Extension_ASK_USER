# ask_user for Pi

A [Pi](https://pi.dev) extension that gives the agent an `ask_user` tool. When a
task leaves an important choice open, the agent stops, shows you one question
with 2–3 options in a dialog, waits for your answer, and continues with it.

## Features

| Feature | What it does |
|---|---|
| One decision question | A question, why it matters, 2–3 options each with a tradeoff, and an optional recommendation |
| Numbered dialog | Uses Pi's built-in dialogs. Tradeoffs are listed above the menu, and `[Recommended]` sits right after its number. |
| Write your own answer | The last choice opens a text box; your text comes back exactly as typed |
| "Also for similar questions" | After each answer, a follow-up lets you apply it to similar decisions for the rest of the session. "Just this time" is the default, so Enter-Enter is the normal flow. |
| Three clear results | `answered`, `cancelled`, or `unavailable`. Only `answered` carries an answer; the tool never picks a default or claims you agreed. |
| Cancel and empty answers | Esc on the menu or the text box, or an empty or whitespace-only answer, gives `cancelled` with the reason |
| Aborts | Stopping the run mid-question gives `cancelled (aborted)`; the question can be asked again later |
| No UI | In print or JSON mode, returns `unavailable` without opening anything |
| Rejects bad calls | Wrong option count, duplicate labels, a recommendation that matches no option, unknown or misplaced fields, a fake `[Recommended]`, or line breaks in labels are all rejected before any dialog opens, so the model fixes its call |
| Repeat questions | The model checks the conversation: for the same decision in the same scenario it reuses your earlier answer (or treats a decline as still open) instead of asking again; a new task that needs its own answer gets a new question that says what is different. The tool itself only merges identical calls fired together in one response into one dialog. |
| One at a time | Calls run sequentially, so two dialogs never overlap |
| On/off switch | `/ask-user on`, `off`, or `status` turns the tool on or off at runtime and remembers it for future sessions. While off, the model sees nothing of `ask_user`. |
| Built-in self-test | `/ask-user-test run_test [seed]` runs a randomized self-test inside Pi (no model, free) |

What you see:

```text
Should the reminder remember previous notifications after Pi restarts?

Why it matters: Persistence changes what you see after a restart and is costly to redo.

1. Session only
   Simpler; forgets everything when Pi restarts.

2. [Recommended] Persist to disk
   Survives restarts; needs a state file and cleanup.

→ 1. Session only
  2. [Recommended] Persist to disk
  3. Write my own answer
```

After you answer:

```text
Apply "Persist to disk" to similar questions this session?
→ 1. Just this time
  2. Also for similar questions this session
```

## How the agent decides when to ask

You never tell the agent to use `ask_user`. Pi adds the tool's description and
guidelines ([src/index.ts](src/index.ts)) to the model's instructions, and the
model decides each time.

| It asks when… | It proceeds without asking when… |
|---|---|
| A choice is **unresolved**: the task doesn't say | You **specified** it ("save to todo.json") |
| **and material**: it changes what you see, the scope, or would cause rework if guessed wrong | You **delegated** it ("your call", "up to you", "as you think best"); it decides and says which option it chose |
| Examples: keep data after restarts or not; delete vs. archive; full vs. incremental backup | It's a **detail you wouldn't notice**: library, file names, flags, code structure |

It also follows these guidelines:
- Ask about the single most important open decision first, before starting the work. Usually one question per task.
- Before asking, check the conversation: if you already answered this decision in the same scenario, reuse that answer (or, if you declined, treat it as still open). If a new task or scenario needs its own answer, ask again and say in the reason what is different.
- After a cancel, don't guess: say the decision is still open, don't ask about it again in this scenario, and continue only with work that doesn't depend on it. After an abort it may ask again.
- With scope `similar`, apply your earlier choice to decisions it judges similar, tell you it did, and ask if unsure.

The guidelines steer the model; they can't force it. The live results below
show how well this model followed them.

## Turning the extension on and off

Inside Pi, with the extension loaded:

| Command | What it does |
|---|---|
| `/ask-user off` | The agent won't ask and will decide on its own. `ask_user` is removed from the active tools, so the model sees neither the tool nor its guidelines. |
| `/ask-user on` | The agent can ask you questions again |
| `/ask-user status` (or just `/ask-user`) | Shows whether it's on, whether it's active in this session, and where the setting is saved |

`/ask_user` works as an alias. The setting is saved in `ask-user-state.json` in
Pi's agent folder (`~/.pi/agent`, or `$PI_CODING_AGENT_DIR` if set) and applied
whenever a session starts, including after `/reload`. With no file it's on; an
unreadable file also means on, with a warning. If Pi was started without the
tool (`--tools` without `ask_user`, `--exclude-tools ask_user`, or
`--no-tools`), `/ask-user on` saves the setting but says it can't take effect
until Pi is restarted without that option.

To load or unload the extension itself, run these from the project folder:

| Goal | Command |
|---|---|
| One session only | `pi -e ./src/index.ts` (add `-e ./scripts/cap-max-tokens.ts` if your API key has a low spending limit). Plain `pi` then runs without it. |
| Always on | `pi install ./` |
| Off for good | `pi remove ./` |
| Toggle an installed copy without removing it | `pi config` (Tab switches personal/project scope) |
| Skip all extensions for one run | `pi -ne` |
| Pick up code edits inside a running Pi | `/reload` |

## Test it yourself in Pi

Start Pi in an empty folder, so the agent can't touch your project:

```bash
mkdir -p ~/ask-user-playground && cd ~/ask-user-playground
pi -e ~/Documents/Ask_user_Pi_extension/src/index.ts -e ~/Documents/Ask_user_Pi_extension/scripts/cap-max-tokens.ts
```

Type `/new` between scenarios so each one starts fresh. Every `ask_user` call and
its result show up in the chat.

| Scenario | Prompt | What you do | What should happen |
|---|---|---|---|
| Pick an option | `Add a reminder that pings me after 30 minutes of work.` | ↑/↓, Enter, then Enter on the follow-up | `ask_user: answered`; the agent builds with your pick |
| Pick against the recommendation | Same | Choose an option without `[Recommended]` | The result says it isn't the recommended option; the agent follows your pick |
| Custom answer | `Make a script that backs up my Documents folder.` | "Write my own answer", type, Enter | Your exact text comes back; the agent uses it |
| Cancel | `Write a script that cleans up old log files in ./logs.` | Esc | `cancelled (dismissed)`; the agent says the decision is open |
| Empty answer | Same | "Write my own answer", Enter with nothing typed | `cancelled (empty_answer)` |
| Apply to similar | The reminder prompt, then `Add a timer that tells me when my coffee is ready.` | First time: "Also for similar questions" | The second task reuses your choice without asking |
| No question needed | `Write a Python to-do CLI that saves tasks to todo.json, with add, list, and done commands.` | — | No dialog; it just builds |
| No UI | `pi -p -e ~/Documents/Ask_user_Pi_extension/src/index.ts -e ~/Documents/Ask_user_Pi_extension/scripts/cap-max-tokens.ts "Add a reminder that pings me after 30 minutes of work." < /dev/null` | — | `unavailable`; the reply says the decision is still open (keep the `< /dev/null`) |
| Self-test, free | `/ask-user-test run_test 42` | — | A PASS/FAIL report in the chat; it doesn't reach the model |
| Turn it off | `/ask-user off`, then the reminder prompt | — | No dialog; the agent decides on its own. `/ask-user on` brings it back. |

To try the dialog itself without a model, load the dev-only
[`scripts/try-ask-user.ts`](scripts/try-ask-user.ts) too and run
`/ask-user-try [reminder|database|norec|invalid]`. It opens the real `ask_user`
dialog with that example and shows the full result the agent would get (the
text and the details); `invalid` shows the tool error instead, with no dialog.
In print mode the result is printed to the terminal.

```bash
pi -e ~/Documents/Ask_user_Pi_extension/src/index.ts -e ~/Documents/Ask_user_Pi_extension/scripts/try-ask-user.ts
```

The model decides when to ask, so a prompt may occasionally not trigger a
dialog. Type `/new` and try again.

## How it was tested

Two layers answer different questions:

- **Does the tool always return the right result?** The fake-dialog tests and
  real Pi dialog tests below answer this without a model. Every run gives the
  same answer.
- **Does the model ask at the right times?** Only live runs can answer this,
  and the model varies, so these results are observations, not proof.

| Layer | What it proves | Latest result |
|---|---|---|
| Unit tests (fake dialog) | Each behavior, checked exactly | 196/196 |
| Batch report (fake dialog) | Every scenario from one file, with a JSON report | 63/63 |
| Randomized self-test (fake dialog) | 30 scenario types per round with random inputs and user actions; expected results are worked out independently of the tool's code | 600/600 (20 rounds) |
| Planted bugs | The tests catch real bugs | Every planted bug caught |
| Real Pi, no model | Pi's actual dialogs over RPC, the on-screen dialog driven by real keystrokes, print mode, the on/off switch across Pi restarts (temp settings folder), and `/ask-user-try` | 27/27 (13 RPC, 7 keystrokes, 1 print, 4 on/off, 2 try); 0 messages reached the model |
| Independent review | A reviewer who didn't write the code reproduced bugs with probes | 11 bugs reproduced and fixed |
| Live: one prompt | End to end with a real model, answering against the recommendation | Passed |
| Live: 8 prompts (5 should ask, 3 shouldn't) | When the model asks | 3/8 at first, 6/8 after tightening the guidelines (one run each) |
| Live: custom / Esc / empty | What the model does with each answer | Custom ✅; empty ✅; after Esc the tool correctly returned `cancelled`, but the model built its own recommended option ❌ |
| Live: similar vs. very different prompts | Whether "Also for similar" is honored and stays in scope | Unrelated tasks still asked ✅; skipping similar ones is inconclusive; the model never said it applied the preference ❌ |

Live runs use the model configured in Pi (here `openrouter/moonshotai/kimi-k2.6`).

### What the tests cover

✅ = tested there; — = not tested there. "Fake" covers the unit tests, the batch
report and the randomized self-test. "Real Pi" is `npm run test:real`: Pi's own
dialogs over RPC and/or real keystrokes, with no model. "Live" means a real model.

| Situation | Fake | Real Pi | Live |
|---|---|---|---|
| **Answers** | | | |
| Pick the recommended option | ✅ | ✅ RPC + keys | ✅ |
| Pick against the recommendation (the result says so) | ✅ | ✅ RPC | ✅ |
| No recommendation (nothing marked) | ✅ | — | — |
| Custom answer kept exactly (spaces, unicode) | ✅ | ✅ RPC + keys | ✅ |
| Custom text equal to the recommended label stays custom | ✅ | — | — |
| Recommendation given in another case is matched | ✅ | — | — |
| **"Also for similar" follow-up** | | | |
| "Just this time" / "Also for similar" | ✅ | ✅ RPC + keys | ✅ |
| Esc, an unexpected value, or an abort on the follow-up keeps the answer | ✅ | ✅ Esc (RPC + keys) | — |
| A long custom answer is shortened in the follow-up title only | ✅ | — | — |
| **Cancel, empty, abort** | | | |
| Esc on the menu | ✅ | ✅ RPC + keys | Tool ✅; the model then built its recommendation ❌ |
| Esc on the text box | ✅ | ✅ RPC + keys | — |
| Empty, whitespace-only, or ideographic-space answer | ✅ | ✅ RPC + keys | ✅ (empty) |
| Run aborted before / during the menu / during the text box | ✅ | — | — |
| **No UI** | | | |
| Print or JSON mode → `unavailable`, no dialog | ✅ | ✅ print | ✅ |
| **Bad calls (rejected, no dialog opens)** | | | |
| 1 or 4 options | ✅ | ✅ (1 option) | — |
| Duplicate labels (case or spacing differences) | ✅ | — | — |
| Recommendation that matches no label, or is empty | ✅ | — | — |
| Unknown or misplaced fields | ✅ | — | ✅ (the model fixed its call) |
| `[Recommended]` anywhere in a label | ✅ | — | — |
| Line breaks in a label or tradeoff | ✅ | — | — |
| Label equal to "Write my own answer" | ✅ | — | — |
| Invalid input with no UI is still rejected | ✅ | — | — |
| **Display** | | | |
| Exact layout: title, tradeoffs, numbered choices, `[Recommended]` | ✅ | ✅ RPC payload + screen | ✅ |
| Line breaks in the question or reason are flattened | ✅ | — | — |
| A dialog value that isn't a displayed choice is never an answer | ✅ | ✅ RPC | — |
| **Repeats** | | | |
| Identical call in a later turn asks again | ✅ | ✅ RPC | — |
| Same question text for a different decision asks | ✅ | — | — |
| Identical calls in one response → one dialog | ✅ (incl. Pi's real `SessionManager`) | — | — |
| A sibling call aborted before it asked doesn't count | ✅ | — | — |
| **On/off switch** | | | |
| `off` / `on` / `status`, and the `/ask_user` alias | ✅ | ✅ | — |
| The setting survives a Pi restart | ✅ | ✅ | — |
| Default on; a corrupt settings file → on plus a warning | ✅ | ✅ | — |
| Pi started with `--tools` excluding the tool | ✅ | ✅ | — |
| **When the agent asks** | | | |
| Unresolved, material choice → asks | — | — | 3 of 5 prompts in run 2 |
| Fully specified, delegated, or routine → doesn't ask | — | — | 3 of 3 prompts in run 2 |

Gaps: aborts, two simultaneous calls, and the model honoring "Also for
similar" have no real-Pi or live coverage.

## How to run the tests

Requires Node 24 (native TypeScript type stripping).

```bash
npm install
```

| Command | What it runs | Cost |
|---|---|---|
| `npm test` | Unit tests, fake dialog | Free |
| `npm run typecheck` | `tsc --noEmit` against Pi's real types | Free |
| `npm run test:batch` | Every scenario in [test/fake-test/batch.ts](test/fake-test/batch.ts) → [results.json](test/fake-test/batch-test/results.json) | Free |
| `npm run test:random -- --seed 42 --rounds 20` | Randomized self-test → [results.json](test/fake-test/random-test/results.json). The seed reproduces a run. | Free |
| `npm run test:real` | Real Pi without a model: dialogs (RPC, keystrokes via `python3`, print mode), the on/off switch, `/ask-user-try` → [results.json](test/real-test/real-dialogs/results.json). Uses a temp settings folder, so your own on/off setting is never changed. | Free |
| `npm run test:live-check` | One live prompt, answered against the recommendation | Model credit |
| `npm run test:live-prompts` | The 8 ask / don't-ask prompts → [results.json](test/real-test/live-prompts/results.json) | Model credit |
| `npm run test:live-answers` | Custom / Esc / empty answers → [results.json](test/real-test/live-answers/results.json). `-- --rescore <file>` rescores without Pi. | Model credit |
| `npm run test:live-similar` | "Also for similar" vs. similar and very different prompts → [results.json](test/real-test/live-similar/results.json) | Model credit |

Every free command exits 1 if anything fails.

Live checks run each prompt in a fresh temp folder with only `ask_user`, `read`,
`write`, and `edit` (no shell). They load two dev-only extensions from
`scripts/`:
- `sandbox-guard.ts` blocks file access outside the temp folder.
- `cap-max-tokens.ts` lowers the requested output tokens, so a key with a low
  spending limit isn't rejected.

## Project layout

| Folder | What's in it |
|---|---|
| `src/` | The extension: tool logic (`ask-user.ts`), registration and model guidance (`index.ts`), merging identical calls in one response (`siblings.ts`), the on/off switch (`toggle.ts`), self-test (`self-test.ts`, `self-test-command.ts`) |
| `test/fake-test/` | Tests that use a fake dialog: no Pi process, no model |
| `test/real-test/` | Tests that run real Pi: real dialogs (free) and live model checks |
| `scripts/` | Dev-only Pi extensions: `try-ask-user.ts` (manual testing), and `sandbox-guard.ts` and `cap-max-tokens.ts` (used by the live checks) |

## Known limitations

- **The model's judgment is guided, not guaranteed.** It may skip a question it
  should ask, or, as seen once, build its recommendation after you cancel.
- **Reusing an earlier answer across turns is the model's judgment.** The tool
  no longer blocks a repeated question (the same question in a different task may
  need a different answer), so the model may ask again in the same scenario, or
  reuse an answer where a new one was needed.
- **"Similar" is judged by the model, not the code.** Matching by wording could
  reuse your answer for a different decision.
- **Not exercised in real Pi:** aborts, and two `ask_user` calls in one response
  (the real-Pi tests drive the tool through a command, not a model response). Both
  are covered by the fake-dialog tests, the second also against Pi's real
  `SessionManager`.
