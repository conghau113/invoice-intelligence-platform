---
name: task
description: Start one planned task by ID (e.g. /task T1.3). Reads the task spec, plans, waits for approval, implements, verifies with evidence, updates the ledger.
disable-model-invocation: true
---
Task ID: $ARGUMENTS

1. Find `### $ARGUMENTS` in `docs/plan/milestones/` and read the whole section. Read every file under "Đọc trước".
2. Check `docs/plan/TASKS.md`: all dependencies must be `DONE`. If not, stop and tell Hậu which ones are missing.
3. Set the task to `DOING` in TASKS.md and update the "Điểm dừng hiện tại" block.
4. Present a plan (in Vietnamese): files to create/change, approach, one alternative you rejected and why, risks, how each "Xong khi" item will be verified. Restate the task's "Ngoài phạm vi" line. If the plan touches architecture, security, auth/tenant isolation, data, licences or cost, present it as research → analysis → comparison with ADR/LEGAL/NFR → risk review → proposal. Then STOP and wait for approval.
5. After approval: implement only what the spec asks. Never do anything listed under "Ngoài phạm vi". If something outside scope is needed, add it under "Phát sinh" in TASKS.md instead of doing it. Never add paid services or dependencies with licences not allowed by docs/LEGAL.md.
6. Run every "Xong khi" check. Paste the commands and their output. If a check fails, fix the root cause; do not weaken the check.
7. Set the task to `REVIEW` in TASKS.md. Summarize in Vietnamese: what changed (file list), how Hậu can run/verify it himself, the riskiest part, and which concepts from "Khái niệm học được" appear where (file:line).
8. Remind Hậu of the next steps: read the diff, ask code-reviewer subagent, run `/gate`, write the learning log, commit. Do not commit.
