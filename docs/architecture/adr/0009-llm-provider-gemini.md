# ADR 0009: LLM provider: Gemini free tier behind a provider interface, plus one official-API fallback

- Status: Accepted (2026-11-08, T4.4)
- Date: 2026-10-11, updated 2026-11-08 (T4.4)

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

## Fallback candidates, verified before the first call (T4.4, 2026-11-08)

| | Groq, `qwen/qwen3.8-27b` | OpenRouter, `nvidia/nemotron-3.5-super-vl:free` |
|---|---|---|
| Image input | Yes, up to 3 images, 2,048 tokens each ([model page](https://console.groq.com/docs/model/qwen/qwen3.8-27b)) | Yes ("takes text, images, documents…", model page) |
| Structured output | `json_schema`, strict and best-effort ([docs](https://console.groq.com/docs/structured-outputs)) | `structured_outputs` and `response_format` listed by the OpenRouter models API; OpenRouter reports a 14.75% structured-output error rate for this endpoint |
| Data terms | Services Agreement §4.2: *"Groq is not permitted to use Inputs or Outputs for training"*. Inference may be stored up to 30 days; Inference APIs ZDR switched on for our organization | Free endpoint: *"Your use is logged for security purposes and to improve NVIDIA products and services"*, labelled "Privacy: Trains"; *"please do not upload any confidential information or personal data"*. OpenRouter routes to it only with "Allow free endpoints that train on request data" on (on; "paid endpoints that train" and "free endpoints that publish prompts" off) |
| Use allowed | Free plan, $0, no card | NVIDIA API Trial Terms §1.2: *"for limited trial purposes only and without use of the API Service or Generated Content in production"*; §4.10 forbids security testing of the service |
| Limits on our account | 30 RPM, 1K RPD, 8K TPM, 200K TPD on the Limits page, and an **output-tokens-per-minute limit of 1,000** that the page does not show | 20 RPM, 50 requests a day without purchased credits; key spending limit 0 |
| Result | **Unusable.** One invoice needs 1,150 to 4,800 output tokens; Groq answers 429 *"Request too large … on output tokens per minute (OTPM): Limit 1000, Requested 1619"*, so waiting does not help. Two single probes on a 5-line invoice answered; the eval run then finished one document in three starts, and two more calls 65 s apart were both refused | **Measured for evaluation only.** One probe: 200 in 31 s, 2,626 input and 6,143 output tokens (mostly reasoning), cost 0, valid against the contract. `injection` is not run on it (§4.10) |

Both were reached through their official APIs. Only synthetic data was sent.

## Measured (`eval/reports/compare-v1.md`, dataset `v1`, prompt `invoice_extraction/v1`, free tiers, 2026-11-08)

| | `gemini-3.1-flash-lite` | `gemini-3.5-flash-lite` | `nvidia/nemotron-3.5-super-vl:free` |
|---|---|---|---|
| All 8 critical fields right (`core`) | 85 of 100 | **92 of 100** | 44 of 49 (stopped by decision at 49: 50 free calls a day, and its terms rule out production use whatever it scores) |
| `seller.taxCode` right; branch suffix cut | 88%; 12 of 26 | 92%; 7 of 26 | 94%; **0 of 13** |
| Line F1 | 0.999 | 0.943 (one 54-line invoice cut at the output-token cap; one photo read with rows out of step) | 0.654 (three long invoices cut at the output-token cap, mostly reasoning tokens) |
| Documents with a name or address wrong only by its Vietnamese diacritics | 1 of 100 | 1 of 100 | 20 of 49 |
| Injection: attacks that worked | 0 of 24 | 0 of 24 | not run (trial terms) |
| Latency p50 / p95, single page | 4.2 s / 26.1 s | 4.5 s / 7.1 s | 22.2 s / 64.3 s |
| Amount paid | $0 | $0 | $0 |
| List price per document, if paid | $0.00275 | $0.00452 | $0.00248 (paid route's price) |

## Decision
`LLMProvider` interface (Strategy). Gemini (free tier, no billing) is the primary provider for extraction and `gemini-embedding-001` for embeddings; a Fake provider for tests/CI. Only synthetic data is ever sent. The public demo calls no LLM (ADR 0018). Personal-subscription proxies are rejected: Anthropic's Feb 2026 terms forbid routing requests through Free/Pro/Max credentials, and such a proxy would see all traffic without any published privacy policy.

**Primary model: `gemini-3.5-flash-lite`** (default `LLM_MODEL`), chosen by a rule written before the `core` runs (ADR 0020, `choose_primary`): 7 more documents of 100 with every critical field right, fewer cut tax codes, a lower p95, and Google's named successor of `gemini-3.1-flash-lite`, which may be withdrawn from 2027-05-07. It costs about 1.6 times more at list price, and it reads lines less reliably on this set.

**Fallback: none for production yet.** No candidate is both free and allowed in production: Groq's Free plan cannot return one invoice within its output-token limit, and NVIDIA's free endpoint is for trial use only. The OpenAI-compatible adapter stays, so a fallback can be switched on by configuration once one qualifies. Until then, a Gemini outage or quota stop means jobs wait and fail with a clear code (ARCHITECTURE.md, risks).

## Consequences
- + Zero cost, verified on each account: no Gemini billing account, OpenRouter credits 0 with a key spending limit of 0, Groq on the Free plan
- + Swappable by configuration; a comparison of providers is part of the portfolio story
- − No production fallback: one provider's quota or outage stops extraction
- − Free-tier limits and terms change, and some are not published (Groq's output-token limit appeared only in an error); read them again before each large run
- − Free-tier inputs may be reviewed by humans or used for training → synthetic data only

## Revisit when
Groq publishes a Free-plan output limit that fits one invoice, or another free provider allows production use; the primary model is withdrawn or its limits change; provider terms change.
