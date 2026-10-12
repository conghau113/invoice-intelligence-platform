# Legal, Data & Licensing Notes

> This is an educational portfolio project. These notes record the constraints the design follows. They are not legal advice; check the original texts before relying on them.

## 1. Data policy
- **Only synthetic data** is used anywhere: code, tests, fixtures, logs, prompts, screenshots, the demo, and backups.
- Synthetic invoices are generated with a fixed seed by `tools/invoice-gen`:
  - tax codes use **invalid check digits**, so they cannot match a real Vietnamese business;
  - company and person names come from Faker and carry the suffix `SAMPLE`;
  - every rendered page carries a `SAMPLE – SYNTHETIC DATA` watermark.
- Real invoices, real tax codes, or real personal data must never be committed, uploaded to the demo, or sent to an LLM provider.

## 2. LLM provider terms (as checked on 2026-10-12)
- **Gemini API, Unpaid Services:** Google uses submitted content and responses to provide, improve and develop its products; human reviewers may read API inputs and outputs; users are told not to submit sensitive, confidential or personal information. Users must be 18+. Apps made available to users in the EEA, Switzerland or the UK must use Paid Services. → We send synthetic data only, and the public demo makes no LLM calls (ADR 0018).
- **Fallback provider:** used only through its official API under its own terms, verified before use (T4.4, ADR 0009).
- **Not used:** tools that route API traffic through personal Claude/ChatGPT/Copilot subscription logins. Anthropic's documentation (updated 2026-02-19) does not permit using Free, Pro or Max plan credentials to route requests for third-party tools.

## 3. Third-party licenses
- **Libraries** linked into our code must use licences on the allow-list: MIT, Apache-2.0, BSD-2/3-Clause, ISC, MPL-2.0, PostgreSQL, Python-2.0. Others need a review entry here before use. CI enforces the list (T7.4).
- **Server components** run unmodified as separate containers (Postgres, Redis, Keycloak) may also be AGPLv3: AGPL obligations concern modified versions of that software offered over a network, which we do not do. Any modification requires a review entry here.
- `THIRD_PARTY_NOTICES.md` is generated from the lockfiles (T7.4).
- Notable components:

| Component | Licence | Notes |
|---|---|---|
| ui-ux-pro-max skill | MIT, © 2024 Next Level Builder | Installed once under `.claude/skills/`; LICENSE file kept |
| Keycloak | Apache-2.0 | Run as container image |
| PostgreSQL | PostgreSQL License | |
| pgvector | PostgreSQL License | |
| Redis 8 (official image) | Tri-licensed RSALv2 / SSPLv1 / AGPLv3 since 2025-05-01; we use it under **AGPLv3**, unmodified, as a separate container | Valkey (BSD-3) was considered but is not on BullMQ's officially tested compatibility list |
| SeaweedFS (optional O1) | Apache-2.0 | |
| MinIO | Not used (community edition archived 2026-04-25) | ADR 0017 |

## 4. Personal data (Vietnam)
- The Personal Data Protection Law No. 91/2025/QH15 has been in force since 2026-01-01. Because the project processes no real personal data and the public demo accepts no uploads, it does not collect personal data from visitors.
- Demo accounts are shared test accounts with fake identities; Keycloak is not used to register real visitors.

## 5. Public demo
- Read-only (`DEMO_READ_ONLY=true`): no uploads, no writes, no live LLM calls; precomputed answers for listed sample questions only.
- Hosted on Oracle Cloud Always Free; the operator account is never upgraded to paid without explicit approval.
- A banner states that all data is synthetic.

## 6. References to other people's work
- Private repositories of other people are not named or quoted in this repository.
- Public sources are cited with links where they informed a decision (ADRs, feasibility notes).
