# ask_user — tool contract and asking policy (W2-0)

This is the agreed interface both workers build and test against. Change it only
through the orchestrator.

## Input

| Field | Type | Rules |
|---|---|---|
| `question` | string | Required. One clear question, non-empty after trimming. |
| `reason` | string | Required. Why the choice matters (behavior, scope, or rework), non-empty. |
| `options` | array of `{ label, tradeoff }` | 2–3 items. `label` and `tradeoff` non-empty. Labels must be unique (case-insensitive, trimmed). |
| `recommendation` | string, optional | If present, must equal one of the option labels. |

Invalid input is a tool error (thrown from `execute`), not one of the three
result states. The model sees the error and can fix its call. No dialog opens.

## Dialog

1. If `ctx.hasUI` is false, open nothing and return `unavailable`.
2. Otherwise call `ctx.ui.select(title, choices, { signal })`:
   - `title` shows the question and the reason.
   - One choice per option: label plus tradeoff, with the recommended one marked.
   - A final choice for writing a custom answer.
3. If the custom choice is picked, call `ctx.ui.input(title, placeholder, { signal })`.
4. Map the user's choice back to the option by its position in the displayed
   list, never by fuzzy text matching.

## Result

Every result has model-facing `content` (text) and structured `details`.

`details.status` is exactly one of:

| Status | When | `details` also includes |
|---|---|---|
| `answered` | User picked an option, or typed a non-empty custom answer | `answer` (option label, or custom text exactly as typed), `source: "option" \| "custom"`, `recommendation` (if any), `followedRecommendation` (boolean, or omitted when there was no recommendation) |
| `cancelled` | Dialog dismissed, custom input dismissed, custom answer empty/whitespace, or the run was aborted | `cancelReason: "dismissed" \| "empty_answer" \| "aborted"` |
| `unavailable` | `ctx.hasUI` is false (print / JSON mode) | — |

All results include `question` in `details`.

Hard rules:

- Only `answered` carries an answer. `cancelled` and `unavailable` never carry a
  default, the recommendation, or any implied consent.
- `answered` is returned only after the human has actually responded.
- A custom answer is returned exactly as typed (the trim is only for the empty
  check).
- If the user picks against the recommendation, the result says so plainly and
  still returns the user's pick.

Model-facing text must state the status first and, for `cancelled` /
`unavailable`, tell the agent not to assume an answer and to name the open
decision instead.

## Clarifications from W2-3

Resolved by the orchestrator from the reviewer's independent cases
(`docs/review/cases.md`, section 4). The conservative choice wins: never claim
an answer the user didn't give.

| # | Topic | Rule |
|---|---|---|
| 1 | Check order | Validate input → if the `execute` signal is already aborted, return `cancelled`/`aborted` (no dialog) → if `!ctx.hasUI`, return `unavailable` → open the dialog. Invalid input throws even when there is no UI. |
| 2 | Text fields | `question`, `reason`, every `label` and `tradeoff` must be non-empty after trimming; they are trimmed for display, for `details.question`, and for the returned option label. Custom answers are **not** trimmed. |
| 3 | Recommendation | Matched against labels with the same rule as uniqueness (trimmed, case-insensitive) and stored as that option's canonical label. `recommendation: ""` or no match → throws. |
| 4 | Layout and distinct choices | Chosen by the human after previewing the real Pi dialog (the old `"label — tradeoff (recommended)"` choices wrapped so the marker looked like it belonged to the next option). **Title:** the question, a blank line, `Why it matters: <reason>`, a blank line, then each option as `<i>. <label>` on one line and `   <tradeoff>` indented on the next, with a blank line between options. **Choices:** short, `<i>. <label>`, with the recommended one as `<i>. [Recommended] <label>` (marker right after the number so it can't wrap away); the custom choice is last and numbered too: `<n+1>. Write my own answer`. Numbering is 1-based and makes every displayed choice unique regardless of label content. Map the returned string with an exact `indexOf` into the displayed list. |
| 5 | Unexpected selection | If `select` resolves to a string that isn't one of the displayed choices, throw an error ("unexpected dialog response"). Never answered, never text-matched. |
| 6 | Abort | Pass the `execute` `signal` to both dialogs. If a dialog resolves `undefined` (or rejects) while the signal is aborted → `cancelled`/`aborted`. A rejection with the signal not aborted is rethrown (tool error). If a dialog resolves a valid choice, the human did respond → treat it as their answer even if an abort lands at the same moment. |
| 7 | Timeout | Never pass `timeout` to dialogs; an auto-dismiss would look like a human decision. |
| 8 | Custom answer and recommendation | `followedRecommendation` is `false` for every custom answer, even if the text equals the recommended label. Custom text is never mapped to an option. |
| 9 | Keys per status | `answered`: `status, question, answer, source`, plus `recommendation` and `followedRecommendation` only when a recommendation exists. `cancelled`: exactly `status, question, cancelReason`. `unavailable`: exactly `status, question`. |
| 10 | Content first line | Exactly `ask_user: answered`, `ask_user: cancelled (dismissed)`, `ask_user: cancelled (empty_answer)`, `ask_user: cancelled (aborted)`, or `ask_user: unavailable`. Custom answers appear JSON-quoted so outer spaces are visible. Picks against the recommendation say so in the content too. |
| 11 | One at a time | `executionMode: "sequential"` so sibling calls never open overlapping dialogs. |
| 12 | Extra fields | Unknown fields are **rejected** (human's decision after the live run, where the model nested `recommendation` inside an option and it was silently dropped). The schema sets `additionalProperties: false` on the input and on each option, and `execute` validation also throws, naming the field (e.g. `options[2].recommendation is not allowed; put "recommendation" at the top level`). No dialog opens. |
| 13 | Input dialog | Title is the question; placeholder invites a free-text answer. |
| 14 | Display-safe labels (W2-4) | Throw, no dialog, if a label starts with `[Recommended]` (case-insensitive, after trimming; point the model to the top-level `recommendation` field), if a label or tradeoff contains a line break, or if a label equals `Write my own answer` (case-insensitive, after trimming). Decided by the human from review findings D1, D2 and the custom-text note. **Amended after the orchestrator's review (A, B):** a label containing `[Recommended]` anywhere (case-insensitive) throws; line breaks in `question` or `reason` are flattened to single spaces in both dialogs (not rejected), so they can't fake option blocks in the title. `details.question` and model-facing text use the same flattened question. |

Known limitation (accepted, not fixed): labels that differ only by invisible or
look-alike Unicode pass validation. Mapping stays correct because of the number
prefix, but the user may not be able to tell them apart. RPC clients are trusted
to relay a human's answer.

## Asking policy (model-facing guidance)

Ask when an unresolved choice **materially changes user-visible behavior,
scope, or the amount of rework**, and the user has not decided it.

Proceed without asking when:

- the user already specified the behavior;
- the user explicitly delegated the choice ("your call", "as you think best");
  make the choice and say which one you made;
- the detail is routine and easy to reverse (names, formatting, internal
  structure, test file layout).

One question per call. Offer 2–3 real options with honest tradeoffs, and
recommend one if you have a view. If the result is `cancelled` or
`unavailable`, do not invent an answer: say which decision is still open and
continue only with work that does not depend on it.

### Ask / proceed examples

| Prompt | Expected | Why |
|---|---|---|
| "Add a reminder that pings me after 30 minutes of work." | **Ask**: should it remember previous notifications after Pi restarts (session-only vs. persisted to disk)? | Persistence changes user-visible behavior and is costly to redo; the user didn't say. |
| "Add the reminder. Keep reminder state only for this session." | **Proceed** | Fully specified. |
| "Make reminders persist or not, as you think best." | **Proceed**, state the choice | Choice explicitly delegated. |
| "Add a command that clears old sessions." | **Ask**: delete permanently vs. move to an archive folder? | Hard to reverse, changes user-visible behavior. |
| "Add a helper to format the reminder message." | **Proceed** | Naming/structure is routine and reversible. |

### Policy decision recorded for the reflection

"Persist or not, as you think best" was originally drafted as the ambiguous
test prompt. We decided it **delegates** the choice, so asking would be
unnecessary friction. The ambiguous scenario instead leaves persistence
unmentioned entirely (first row above).
