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
7. Set the task to `REVIEW` in TASKS.md. Write the task note `docs/learning/T<n>.<m>-task-notes.md` (Vietnamese, docs only; the gate note is a separate file) with these sections: **Đã làm** (file list), **Cách tự chạy lại**, **Phương án đã loại** (and why), **Rủi ro** (riskiest parts, each with where it shows up and how it is caught or what is still open; mirror anything added to "Phát sinh"), **Khái niệm học được** (each concept from the spec mapped to file:line, plus one line on what it means in this task). Verify every file:line against the files as they are now. Then summarize the same content in the reply.
8. Remind Hậu of the next steps: read the diff, ask code-reviewer subagent, run `/gate`, write the learning log, commit. Do not commit. If the reviewer or the gate finds new risks, append them to the task note.
