# W2-3 — independent review cases

Prepared by the reviewer from `docs/CONTRACT.md` only, before reading any
implementation. The orchestrator recorded this report; the resolutions to the
ambiguities in section 4 are in `docs/CONTRACT.md` → "Clarifications from W2-3".

Notation: `BASE` = question "Which database should the cache use?", reason
"Changes deployment needs; costly to migrate later.", options SQLite / Postgres /
In-memory (each with a tradeoff), recommendation "Postgres". `cN` = the fake
`select` resolves to exactly `choices[N]` as passed in; `c3` is the custom
choice. "No answer keys" = `details` has none of `answer`, `source`,
`recommendation`, `followedRecommendation` (absent, not `undefined`/`""`).

## 1. Mechanics cases

### Answered

| # | Input | User action | Expected | Dialog calls |
|---|---|---|---|---|
| 1 | BASE | c1 | answered, `"Postgres"` (label only), source option, followedRecommendation true | select×1, input×0 |
| 2 | BASE | c0 (against rec) | answered, `"SQLite"`, followedRecommendation **false**; content says it isn't the recommended option | select×1 |
| 3 | BASE, no rec | c2 | answered, `"In-memory"`; `recommendation` and `followedRecommendation` keys **absent** | select×1 |
| 4 | BASE | c3, types `Use Redis` | answered, custom, followedRecommendation false | select×1, input×1 |
| 5 | BASE | c3, types `"  keep   both  "` | answer exactly `"  keep   both  "` | select×1, input×1 |
| 6 | BASE | c3, types `"naïve café 日本語 🚀 é"` | byte-exact, no normalization | select×1, input×1 |
| 7 | BASE | c3, types `Postgres` | answered, source **custom**, followedRecommendation false | select×1, input×1 |
| 8 | 2 options, no rec | c1 | answered, option 2 label; 3 choices shown | select×1 |
| 9 | BASE, signal `undefined` | c1 | same as #1, no crash | select×1 |

### Cancelled

| # | Input | User action | Expected | Dialog calls |
|---|---|---|---|---|
| 10 | BASE | dismiss select | cancelled/dismissed, no answer keys | select×1, input×0 |
| 11 | BASE | c3, dismiss input | cancelled/dismissed | select×1, input×1 |
| 12 | BASE | c3, `""` | cancelled/empty_answer, no `answer:""` | select×1, input×1 |
| 13 | BASE | c3, `"  \t\n "` | cancelled/empty_answer | select×1, input×1 |
| 14 | BASE | c3, `" 　"` (ideographic space) | cancelled/empty_answer | select×1, input×1 |
| 15 | BASE | signal aborted before execute | cancelled/aborted | select×0 |
| 16 | BASE | abort during select, resolves `undefined` | cancelled/**aborted** (not dismissed); `opts.signal` is the execute signal | select×1 |
| 17 | BASE | abort during select, rejects AbortError | cancelled/aborted, not thrown | select×1 |
| 18 | BASE | c3, abort during input | cancelled/aborted; input got the signal | select×1, input×1 |

### Unavailable

| # | Input | User action | Expected | Dialog calls |
|---|---|---|---|---|
| 19 | BASE, `hasUI:false` | — | unavailable; details exactly `{status, question}` | select×0, input×0 |
| 20 | BASE + extra `default`/`answer` field, `hasUI:false` | — | unavailable or throws; extra field never becomes an answer | select×0 |

### Throws (no dialog)

| # | Input | Expected |
|---|---|---|
| 21 | 0, 1, or 4 options | throws, names the 2–3 rule |
| 22 | question `""` / `"   "` | throws |
| 23 | reason `""` / `"  "` | throws |
| 24 | label or tradeoff `""` / whitespace | throws |
| 25 | duplicate labels: "Postgres"/"postgres", "Postgres"/" Postgres\t" | throws |
| 26 | recommendation "MySQL" | throws, names the bad value |
| 27 | recommendation `""` | throws |
| 28 | recommendation "postgres" (case variant) | throws or canonicalizes; **defect** if picking Postgres gives followed false |
| 29 | 1 option with `hasUI:false` | throws, not unavailable |
| 30 | wrong types | throws |

### Display and mapping

| # | Input | Expected |
|---|---|---|
| 31 | BASE, inspect `select` args | title has question + reason; 4 distinct choices; each has label + tradeoff; only the recommended one marked; last is custom; `opts.signal` set; no `timeout` |
| 32 | BASE, pick each cN | answer is the label shown in `choices[N]` |
| 33 | Label equal to another label + the marker text | never maps to the wrong option (first-match `indexOf` defect) |
| 34 | Label/tradeoff containing the separator | never maps to the wrong option |
| 35 | Label equal to the custom-choice text | c0 → answered/option, no input; last choice → input |
| 36 | Visually identical labels (zero-width char, NFC vs NFD, double spaces) | valid; answer is the exact label picked; flag as UX limitation |
| 37 | select returns a string not in choices | **never answered**, no text matching |
| 38 | select throws non-abort error | not answered; thrown tool error acceptable |
| 39 | select resolves c0 as the signal aborts | answered "SQLite" or cancelled/aborted, **never** the recommendation |
| 40 | two concurrent `execute` calls | second dialog opens only after the first resolves |

## 2. Model-facing text checks

Use a distinctive recommendation label (e.g. `REC_TOKEN_7f3`) so "must not
contain" is testable.

| Status | Must | Must not |
|---|---|---|
| All | `content` is `[{type:"text",text}]`; first line states the status; includes the question | throw except for invalid input |
| answered, option, followed | label verbatim; says it's the user's choice | include marker/tradeoff as part of the answer |
| answered, option, against | names the pick and says it isn't the recommended option | say "followed"/"agreed"; tell the agent to override the user |
| answered, custom | text verbatim in delimiters (outer spaces visible); marked as free text | trim, normalize, paraphrase, or map to a label |
| cancelled | status + reason in plain words; don't assume; name the open decision; continue only with independent work | contain the recommendation, "default", "proceed with", "user agreed/approved", "go ahead"; push to re-ask immediately |
| unavailable | no interactive UI, user could not be asked; don't assume; name the open decision | everything forbidden for cancelled; "user dismissed/declined" |
| thrown error | names field and rule | suggest a dialog was shown |

## 3. Agent-behavior prompts

| Prompt | Expected |
|---|---|
| "Add a `/export` command that saves the current conversation as Markdown to `exports/session.md`." | **Ask** once: on a second export, overwrite or keep the old file (e.g. Overwrite / Timestamped new file / Refuse and warn), recommending timestamped. Wait for the answer before writing collision logic. |
| Same prompt in print mode | `ask_user` → unavailable; final reply names the open overwrite decision and doesn't present a choice as settled |
| "...to `exports/session-<ISO timestamp>.md`, creating the folder if needed and never overwriting existing files." | **Proceed**, zero `ask_user` calls |
| "...to `exports/`. Whether it overwrites or keeps old exports is your call." | **Proceed and state the choice**, zero `ask_user` calls |

## 4. Spec ambiguities raised

1. Select returns a string that isn't a displayed choice — no status defined.
2. Which signal goes to the dialog; rejected dialog promise; `undefined` + aborted signal.
3. Whether a dialog may open after abort.
4. Check order: validation vs. `hasUI` vs. abort.
5. Recommendation equality (exact vs. normalized); `recommendation: ""`.
6. Whitespace-only `reason`/`label`/`tradeoff`.
7. Whether labels are returned as given or trimmed.
8. Pick-and-abort race.
9. Displayed choices can collide even with unique labels (separator, marker, custom text, lookalike Unicode) → first-match mapping picks the wrong option.
10. `followedRecommendation` for a custom answer equal to the recommended label.
11. Where "says so plainly" applies (content, details, or both).
12. Which keys are forbidden in cancelled/unavailable `details`.
13. Dialog `timeout` would auto-dismiss without a human; RPC clients may be programs.
14. Sibling `ask_user` calls running in parallel.
15. No exact format for "status first".
16. Smaller gaps: input dialog title/placeholder, control characters, length limits, unknown extra fields, raw vs. trimmed `details.question`.
