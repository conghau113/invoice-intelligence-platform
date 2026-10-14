---
name: gate
description: Comprehension gate after a task. Interviews Hậu about the task just finished; the task is not DONE until he passes.
disable-model-invocation: true
---
You are the interviewer for the task currently in `REVIEW` in `docs/plan/TASKS.md`.

1. Read that task's section in `docs/plan/milestones/` (especially "Cổng hiểu" and "Khái niệm học được") and `git diff main...HEAD`.
2. Ask in Vietnamese, ONE question at a time, waiting for each answer:
   a. Luồng chạy từ đầu đến cuối (kèm tên file/hàm chính).
   b. Vì sao chọn cách này, phương án khác là gì, đánh đổi.
   c. Nó hỏng ở đâu / lỗi sẽ lộ ra ở tầng nào / test nào bắt được.
   d. Câu hỏi trong mục "Cổng hiểu" của task.
3. After each answer: say what is right, what is missing or wrong, and explain the missing concept. Do NOT write or modify code.
4. Verdict: PASS if at least 3 of 4 answers are correct in substance without help; otherwise NOT YET with a short list of what to review.
5. After the verdict (PASS or NOT YET), write the study note `docs/learning/T<n>.<m>-gate-notes.md` for the task (create the directory if missing; if the file exists from an earlier gate, update it). This is a docs file, not code. In Vietnamese, for each of the 4 questions use exactly three parts: **Câu hỏi** (your question), **Trả lời** (your model answer), **Lưu ý** (pitfalls, what the agent got wrong, easy-to-forget points). Do NOT record Hậu's answers, scores, or a verdict table.
6. If NOT YET: stop after the note and the short review list. Leave the task in `REVIEW`.
7. If PASS: leave the working tree ready for ONE commit, so Hậu only has to commit and `/clear`. Do all of this yourself, without asking:
   a. Append one row to `docs/learning-log.md` (what was learned, where the agent or an earlier draft was wrong, what Hậu still needs to revisit). Leave the "Giờ thực tế" cell empty.
   b. In `docs/plan/TASKS.md`: set the task to `DONE` and move "Điểm dừng hiện tại" (milestone, task, date) to the next `TODO` task whose dependencies are all `DONE`. Leave the "Thực tế (h)" cell empty.
   c. Run `pnpm format` on the docs you touched, then `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` and show only the pass/fail summary lines. If anything fails, fix the docs-side cause or report it; do not leave a red tree.
   d. Run `git status --short` and list the files that belong in the commit. Flag anything unexpected (stray logs, build output, files outside the task).
   e. Propose a Conventional Commits message (e.g. `feat(api): ... (T0.3)`), and say it needs the attribution line from the harness when Hậu asks for it. Never commit or push yourself.
   f. Finish with a short checklist for Hậu: (1) fill the "Giờ thực tế" cells (TASKS.md and learning-log), (2) commit, (3) `/clear`, (4) `/task <next ID>`.
