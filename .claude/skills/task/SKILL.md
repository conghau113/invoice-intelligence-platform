---
name: task
description: Start one planned task by ID (e.g. /task T1.3). Reads the task spec, plans, waits for approval, implements, verifies with evidence, updates the ledger.
disable-model-invocation: true
---
Task ID: $ARGUMENTS

1. Find `### $ARGUMENTS` in `docs/plan/milestones/` and read the whole section. Read every file under "Đọc trước".
2. Check `docs/plan/TASKS.md`: all dependencies must be `DONE`. If not, stop and tell Hậu which ones are missing.
3. Set the task to `DOING` in TASKS.md and update the "Điểm dừng hiện tại" block.
4. Before writing the plan, do the cross-check below for EVERY task (not only architecture tasks) and put its result in the plan as a short "Đối chiếu" table (item → khớp / lệch / không liên quan, with file:line or ADR number). Fix the plan yourself until nothing is "lệch"; do not hand Hậu a first draft that still needs a review round.
   - Whole-plan alignment (do this FIRST, before the plan is drafted; a plan built only from this task's own spec is not allowed):
     - Read the milestone header (goal, "Demo khi xong", "Cuối mốc" checks) in the same `M<n>.md`, and `docs/plan/WORKFLOW.md`.
     - Find downstream consumers: grep `docs/plan/milestones/` for the task ID in other tasks' "phụ thuộc" and for the names of this task's outputs (files, claims, tables, env vars, ports, user names). Read each consumer's full section (also in later milestones, and the milestone's end-of-milestone demo/checks).
     - For every consumer, write one line in the "Đối chiếu" table: what it needs from this task's output (format, id type, field name, scope, permission) → how the plan provides it. If a consumer needs something the spec does not list, add it to the plan if it is cheap and inside "Ngoài phạm vi"; otherwise add a row under "Phát sinh" naming the consumer task.
     - Also read the upstream tasks this one depends on (their notes in `docs/learning/` and "Phát sinh" rows mentioning this task ID) so earlier findings are not lost.
     - State in the plan which "Demo khi xong" / end-of-milestone check this task contributes to.
   - ADRs: read every ADR the task touches (grep `docs/architecture/adr/` for the feature, tool or path names) and `docs/architecture/ARCHITECTURE.md` sections on the same area. Quote the sentence that constrains the plan.
   - LEGAL/NFR/SECURITY: new dependency → licence on the allow-list; any cost; any logging of document content or PII.
   - Repo reality: `ls`/`grep` the files and directories the spec assumes. If the spec refers to something that does not exist yet (e.g. a folder created in a later milestone), say so and design for both cases; a check that silently skips forever is a dead gate.
   - Existing config that can silently defeat the change: `turbo.json` inputs/cache, `.prettierignore`, `.gitignore`, CI `--filter`, `package.json` scripts and `check:*` chains, hooks in `.claude/hooks`.
   - Existing content the new check will run on: dry-run the idea on current files first, so you know up front whether it fails on day one (and if so, that fixing content may be out of scope → "Phát sinh").
   - Quality gates that will judge the diff: SonarCloud (Security Rating A; avoid `os.tmpdir()` writes, PATH-based `spawn`, unbounded regex), gitleaks, `.claude/hooks/guard.mjs` (split chained git commands). Prefer committed fixtures and `process.execPath` over temp dirs and shell lookups.
   - Tests: every new gate needs a negative test that runs the real code and expects failure; no source-grepping tests.
5. Present a plan (in Vietnamese) that opens with the "Đối chiếu" table, then: files to create/change, approach, one alternative you rejected and why, risks, how each "Xong khi" item will be verified. Restate the task's "Ngoài phạm vi" line. If the plan touches architecture, security, auth/tenant isolation, data, licences or cost, present it as research → analysis → comparison with ADR/LEGAL/NFR → risk review → proposal. Then STOP and wait for approval.
6. After approval: implement only what the spec asks. Never do anything listed under "Ngoài phạm vi". If something outside scope is needed, add it under "Phát sinh" in TASKS.md instead of doing it. Never add paid services or dependencies with licences not allowed by docs/LEGAL.md.
7. Run every "Xong khi" check. Paste the commands and their output. If a check fails, fix the root cause; do not weaken the check.
8. Set the task to `REVIEW` in TASKS.md. Write the task note `docs/learning/T<n>.<m>-task-notes.md` (Vietnamese, docs only; the gate note is a separate file) with these sections: **Đã làm** (file list), **Cách tự chạy lại**, **Phương án đã loại** (and why), **Rủi ro** (riskiest parts, each with where it shows up and how it is caught or what is still open; mirror anything added to "Phát sinh"), **Khái niệm học được** (each concept from the spec mapped to file:line, plus one line on what it means in this task). Verify every file:line against the files as they are now. Then summarize the same content in the reply.
9. Remind Hậu of the next steps: read the diff, ask code-reviewer subagent, run `/gate`, write the learning log, commit. Do not commit. If the reviewer or the gate finds new risks, append them to the task note.
