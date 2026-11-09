---
name: ship
description: Land a finished task or change: branch, grouped commits, local gate, push, PR, watch CI and SonarCloud until green, then merge. Runs only when Hậu types /ship.
disable-model-invocation: true
---

Land the work in the current working tree. Reply in Vietnamese. Arguments: `$ARGUMENTS`
(optional: `--merge` = merge without asking once everything is green; `--draft` = open the PR as Draft and stop after step 4; any other words = a hint for the commit/PR title, e.g. a task ID).

Typing `/ship` IS Hậu's request to commit and push in this message (CLAUDE.md: never commit or push otherwise). It is NOT permission to merge: merge only with `--merge` in the arguments or after Hậu says so after seeing green checks.

## 1. Look before touching anything

- `git branch --show-current`, `git status --short`, `git diff --stat`. Read `docs/plan/TASKS.md` (current task and its status).
- If the work is a task, it must be `DONE` (it passed `/gate`). If it is `REVIEW`/`DOING`, stop and say so. Work that is not a task (tooling, a fix) is fine: name it from the arguments.
- List what will be committed and flag anything that does not belong, then ask before including it: untracked config such as the MCP config file, environment files (a hook blocks them anyway), logs, `test-results/`, `dist*`, `.next`, files unrelated to the task. Never `git add -A` or `git add .`: add files by name or pathspec with explicit excludes.
- If on `main`, create a branch first: `task/<ID>-<slug>` for a task, `task/<slug>` otherwise.

## 2. Commit

- Conventional Commits, English, imperative: `feat(api,ai,web): ... (T2.9)`. Scope is the app(s); put the task ID in parentheses when there is one.
- Group by purpose, not by size. Dependency or security bumps (`chore(deps)`, `chore(web)`) are their own commit, before the feature. Docs, task notes, the learning log and the TASKS.md ledger go into the feature's last commit (memory: batch, do not push each small change).
- When two commits must touch the same file (typically `pnpm-lock.yaml`), build the first one without disturbing the tree: `git worktree add ../iip-tmp HEAD`, make that change there (for a lockfile: edit `package.json`, then `pnpm install --lockfile-only`), save `git diff` to a file in the scratchpad, then `git apply --cached <file>` in the real tree, commit, and remove the worktree (`git worktree remove --force` on its own command line: the guard hook blocks a line that also contains `git push`).
- Message body: why, not a file list. End every commit with the attribution line from the harness system reminder in force at that moment (do not copy a model name from an older commit or from this file). Pass the message with a heredoc.
- Never `--no-verify`, never `-c core.hooksPath=...`, never `--force`. A denied command means adjust the plan.
- Run each git command on its own line (the guard hook has a false positive on a line that has `git push` and, later, `--force` or `-f`).

## 3. Local gate, then push

- `pnpm format:check` and `pnpm check:fast`. Add what the diff touches: `pnpm check` (docs, i18n, contracts), `pnpm test:scripts` (anything under `scripts/`), `pnpm --filter api test:int` (needs Docker; when `apps/api` database or queue code changed). Show only the pass/fail summary lines. If one fails, fix the cause (not the check) and make a new commit; never rewrite what is already pushed.
- `git push -u origin <branch>` once.
- If the branch already has an open PR (`gh pr view --json number,isDraft,state`), reuse it: push to it, and when the task is `DONE` and `--draft` was not given, mark it ready with `gh pr ready <N>` (SonarCloud may only analyse a PR once it is ready). Otherwise `gh pr create` (Draft only with `--draft` or when the task is not DONE). Title = the main commit's subject. Body: Summary (3 bullets), Test plan as a checklist (what ran locally, what is left to CI), and the PR attribution line from the harness system reminder. Take the content from `docs/learning/T<n>.<m>-task-notes.md` when it exists. No secrets, cookies, tokens or document content in it.

## 4. Watch CI and SonarCloud

- Wait with one background command: `until ! gh pr checks <N> 2>&1 | grep -qE "pending|queued|in_progress"; do sleep 15; done; gh pr checks <N>`. Do not poll with repeated short sleeps.
- A push that touches what `.github/workflows/eval.yml` watches (prompt, providers, `config.py`, output schema, PDF/image pipeline, `eval/runner`, `eval/baselines`, `eval/datasets`, the workflow) also runs the real-model `smoke` gate: ~20–30 free-tier calls and several minutes. Say so before pushing. `smoke` red with exit 1 is a real accuracy drop; exit 2 ("NOT JUDGED": quota, 503) means rerun it (`gh run rerun <run> --failed`), never merge on it. A `cancelled` smoke run is not green.
- SonarCloud is an external check that can be red while the CI jobs are green. After checks finish, read its public API (no auth) and report the gate plus open issues:
  `https://sonarcloud.io/api/qualitygates/project_status?projectKey=conghau113_invoice-intelligence-platform&pullRequest=<N>` and `https://sonarcloud.io/api/issues/search?componentKeys=conghau113_invoice-intelligence-platform&pullRequest=<N>&resolved=false`.
- A job failed: `gh run view <run> --job <job> --log-failed`, find the root cause, fix it inside the scope of this diff, make ONE new commit, push once, watch again. Stop after two fix rounds and report instead of looping. A failure that is not caused by this diff (flaky, a break already on the base branch): say so, do not paper over it.
- Sonar issues that are only maintainability and do not fail the gate are not fixed here: add one row under "Phát sinh" in TASKS.md (rule, file:line, who should clean it) with the next commit you make, never as an extra push just for that.
- Never weaken a check, skip a job or edit the workflow to get green.

## 5. Merge (only with `--merge` or after Hậu says so)

- Re-check that every check is `pass` and the Sonar gate is `OK` right before merging.
- `gh pr merge <N> --merge` (keeps history). Never `--delete-branch` and never delete a `task/*` branch afterwards: Hậu keeps every merged task branch to compare later. Only throw-away drill branches (never merged) may be deleted, and only when Hậu says so. Then, as separate commands: `git switch main`, `git pull --ff-only`, and show `git log --oneline -3` and `git status --short`.
- Without `--merge`: print the PR URL and the check table, say "bảo mình merge khi sẵn sàng", then stop.

## 6. Finish with a short checklist for Hậu

1. Fill the "Giờ thực tế" cells (TASKS.md and learning-log.md) for the task, if any.
2. Decide what to do with the leftovers you flagged (untracked files, new "Phát sinh" rows).
3. `/clear`, then `/task <next ID>`.

Do nothing else: no refactors, no new features, no changes outside the diff's scope.
