# ADR 0018: Public demo is read-only and makes no live LLM calls

- Status: Accepted
- Date: 2026-10-11

## Context
A public demo attracts arbitrary visitors. Risks: (1) visitors uploading real invoices with personal data (Vietnam's Personal Data Protection Law 91/2025/QH15 in force since 2026-01-01); (2) Gemini Unpaid Services terms require Paid Services for API clients available to users in the EEA/CH/UK, and recruiters may be there; (3) quota exhaustion and abuse.

## Options considered
1. Full app open to the public
2. Login-gated full app
3. Read-only demo with precomputed results
4. Video only

## Decision criteria
- Legal exposure
- Provider-terms compliance
- Cost/quota
- Recruiter experience

## Decision
`DEMO_READ_ONLY=true` on the public instance: only GET requests (403 `DEMO_READ_ONLY` otherwise), no upload UI, no LLM calls; data is synthetic and pre-processed; Q&A serves precomputed answers for a published list of sample questions; a banner explains that the full pipeline is shown in the video and runnable locally from the repo.

## Consequences
- + No personal data intake, no terms issue, no quota burn
- + Recruiters still see real screens and real numbers
- − Visitors cannot try their own documents (documented; they can run it locally)

## Revisit when
A paid provider with appropriate terms is approved by the owner, and a data-protection review is done.
