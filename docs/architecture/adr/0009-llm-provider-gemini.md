# ADR 0009: LLM provider: Gemini free tier behind a provider interface, plus one official-API fallback

- Status: Proposed — confirm with M4 numbers
- Date: 2026-10-11

## Context
Need vision extraction, structured output, embeddings and answers at zero cost. Gemini API is available in Vietnam and has a free tier (no billing account). A March 2026 public benchmark of 20 invoices reported Gemini 3 Pro at 94.75% field accuracy (small sample, vendor blog). Unpaid Services terms: content may be used to improve Google products, human reviewers may read inputs/outputs, and users must not submit personal information; apps offered to users in the EEA/CH/UK must use Paid Services.

## Options considered
1. Gemini API free tier
2. Other official free APIs (Groq, OpenRouter free models)
3. Paid APIs (OpenAI, Anthropic, Gemini paid)
4. Proxies that route through personal subscriptions (e.g. 9Router)
5. Local open models

## Decision criteria
- Zero cost
- Extraction accuracy on our dataset
- Image input + structured output support
- Terms compatible with how we use it
- Ability to swap

## Decision
`LLMProvider` interface (Strategy). Gemini (free tier, no billing) is the primary provider for extraction and `gemini-embedding-001` for embeddings; a Fake provider for tests/CI; one fallback provider through its official API, chosen in T4.4 after verifying image input, structured output and data terms. Only synthetic data is ever sent. The public demo calls no LLM (ADR 0018). Personal-subscription proxies are rejected: Anthropic's Feb 2026 terms forbid routing requests through Free/Pro/Max credentials, and such a proxy would see all traffic without any published privacy policy.

## Consequences
- + Zero cost; comparison of providers is part of the portfolio story
- + Swappable by configuration
- − Free-tier limits and terms change; configured, not hard-coded
- − Free-tier inputs may be reviewed by humans → synthetic data only

## Revisit when
When M4 measurements are available (update this ADR) or provider terms/limits change.
