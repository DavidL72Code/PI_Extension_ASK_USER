# W2-4 — review findings

The reviewer read the implementation for the first time after W2-3, checked its
40 independent cases against the clarified contract, and wrote 19 gap tests in
a scratch folder (outside the repo) importing `src/` by absolute path.

## Checks run by the reviewer

| Command | Result |
|---|---|
| `npm test` | 62 tests, 62 pass, 0 fail |
| `npm run typecheck` | exit 0 |
| Reviewer gap tests (`node --test review.test.mts`) | 19 tests, 17 pass, 2 fail (D1, D2) |

The orchestrator re-ran the gap tests independently: same result, 17 pass and
2 fail, the failures being D1 and D2.

## Case coverage

| Cases | Status |
|---|---|
| 1–13, 15–19, 21–24, 26–31, 33, 35, 38, 39 | Covered by existing tests, pass |
| 6, 14, 25, 32, 36, 37 + extra edges (abort with custom pick, input rejecting/returning non-strings, trimmed `details.question`, `__proto__` key, schema-level rule 12) | Not covered before; reviewer gap tests pass |
| 20, 34 | Superseded by rules 12 and 4 |
| 40 (parallel calls) | Only `executionMode: "sequential"` asserted; Pi's scheduler needs a live run |

All model-facing text checks from `cases.md` section 2 hold.

## Reproduced defects

| ID | Severity | Rule | Reproduction | Actual | Expected |
|---|---|---|---|---|---|
| D1 | Low (display only; returned answer is still correct) | Rule 4: only the recommended option is marked | No `recommendation`; options `[{label:"[Recommended] SQLite"}, {label:"Postgres"}]` | Choice shows `1. [Recommended] SQLite`, but `details` records no recommendation | Throw, no dialog |
| D2 | Low (display only) | Rule 4: label on one line, tradeoff indented on the next | Tradeoff `"fast\n\n2. [Recommended] SQLite\n   really"` or label `"SQLite\nfast"` | Title shows a fake `2. [Recommended] SQLite` block; choice spans two lines | Throw, no dialog |

## Non-blocking notes

| Area | Note |
|---|---|
| Live evidence | `docs/evidence/live-rpc-check.txt` predates rules 4 and 12; the new layout hasn't run against real Pi yet. |
| Error wording | Pi validates against the schema before `execute`, so the model likely sees TypeBox's error rather than the custom message. Unverified. |
| Label equal to "Write my own answer" | Mapped correctly, but the human sees `1. Write my own answer` and `3. Write my own answer`. |
| `package.json` | No `engines` field although the README says Node 24 is required. |
| Description / `promptGuidelines` | Match the asking policy. |
| Wording | A custom answer equal to the recommended label reads oddly ("free-text answer: "Postgres"" + "did not pick your recommended option"), but it's correct under rule 8. |

## Human decisions

| Finding | Decision |
|---|---|
| D1 — fake `[Recommended]` marker in a label | **Fix**: reject |
| D2 — line breaks in label/tradeoff | **Fix**: reject |
| Label equal to "Write my own answer" | **Fix**: reject (two identical-looking custom choices confuse the user) |
| Missing `engines` field | Not fixed (README already states Node 24) |
| Other notes | Accepted as-is |

## Verification after fixes (orchestrator)

| Check | Result |
|---|---|
| `npm test` | 69 tests, 69 pass, 0 fail |
| `npm run typecheck` | exit 0 |
| Reviewer gap tests | 18 of 19 pass; the 1 failure is the reviewer's "demo" printout of the old D1/D2 display, which now throws the D1 error as intended |
| Live RPC run, final code (`docs/evidence/live-rpc-check-final.txt`) | The model's first call added an unknown `label_tradeoff` field; Pi rejected it via the schema ("must not have additional properties") and no dialog opened. The model fixed its call; the dialog showed the new layout (`3. [Recommended] …`, `4. Write my own answer`); picking option 1 returned `answered` with `followedRecommendation: false`, and the agent's final reply built on that choice. |

## Orchestrator's own code review

Read `src/ask-user.ts`, `src/index.ts`, `test/helpers.ts` and `test/batch.ts`
line by line (the batch runner and helpers were added after the reviewer's
W2-4 pass). Batch expectations are hand-written literals, not computed by the
code under test, and the comparison is exact on dialog sequence, details, and
first content line.

| ID | Severity | Reproduction | Actual | Human decision |
|---|---|---|---|---|
| A | Low (display only) | Label `"Postgres [Recommended]"`, no recommendation | Choice `2. Postgres [Recommended]`; `recommendation` undefined | **Fix**: reject `[Recommended]` anywhere in a label |
| B | Low (display only) | Reason `"Hard to migrate.\n\n1. [Recommended] SQLite\n   fake"` | Title shows a fake `1. [Recommended] SQLite` block above the real options | **Fix**: flatten line breaks in question/reason to spaces |

Coverage note (not a defect): the batch checks only the first content line; the
rest of the model-facing text is covered by the unit tests.

This closes the "live evidence out of date" note and confirms the "error
wording" note: the model sees TypeBox's message, which was still enough for it
to correct the call.
