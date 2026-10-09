# Dependency plan and worker briefs

Workflow: one orchestrator (main Claude Code session) and two Claude Code
subagents, used in place of herdr. The submission allows "herdr or another
workflow".

## Task graph

```
W2-0 → W2-1 ─┬→ W2-2 ─┐
              └→ W2-3 ─┴→ W2-4 → W2-5
```

| ID | Task | depends_on | Owner | Evidence |
|---|---|---|---|---|
| W2-0 | Tool contract and asking policy | [] | Orchestrator + human | `docs/CONTRACT.md` |
| W2-1 | Failing contract tests (fake dialog) | [W2-0] | Implementer | `test/`, `docs/evidence/w2-1-failing-tests.txt` |
| W2-2 | Register and implement `ask_user` | [W2-1] | Implementer | Passing tests, `docs/evidence/w2-2-passing-tests.txt`, live dialog check |
| W2-3 | Independent review cases | [W2-1] | Reviewer | `docs/review/cases.md` (written by orchestrator from the reviewer's report) |
| W2-4 | Review and fix supported findings | [W2-2, W2-3] | Reviewer finds, implementer fixes | `docs/review/findings.md`, rerun test output |
| W2-5 | Demo and submit | [W2-4] | Human | Video, PR, reflection |

## File ownership

| Path | Owner |
|---|---|
| `src/**`, `test/**`, `scripts/**`, `package.json`, `tsconfig.json`, `README.md`, `.gitignore` | Implementer (only worker allowed to edit the working tree) |
| `docs/CONTRACT.md`, `docs/PLAN.md`, `docs/review/**` | Orchestrator |
| Nothing | Reviewer (read-only; returns findings and proposed tests as text) |

## Brief: implementer

- **Spec:** `docs/CONTRACT.md` is the source of truth for inputs, results, and
  asking policy.
- **Repo:** this folder. Pi 0.87.1, extension API from
  `@earendil-works/pi-coding-agent` (`pi.registerTool`, `ctx.ui.select`,
  `ctx.ui.input`, `ctx.hasUI`).
- **W2-1:** write failing tests first with a fake dialog covering option
  selected, custom answer, dismissed, empty custom answer, and no UI. Check
  status and answer exactly. Save the failing run as evidence.
- **W2-2:** smallest implementation that passes. Use Pi's built-in dialogs, not
  a custom TUI. Add model-facing description and prompt guidelines matching the
  asking policy. README with run and test instructions.
- **Unresolved decisions:** report them to the orchestrator; don't guess.

## Brief: reviewer

- **Spec:** `docs/CONTRACT.md` only; do not read the implementation until W2-4.
- **W2-3:** independently derive cases and expected outcomes, including
  ambiguous option labels, dismissed input, no UI, empty answer, and an answer
  that contradicts the recommendation. Prepare one genuinely unresolved design
  prompt (should ask) and one fully specified prompt (should not ask).
- **W2-4:** review the finished implementation, run the checks, and report only
  defects you can reproduce. No edits to the working tree.
