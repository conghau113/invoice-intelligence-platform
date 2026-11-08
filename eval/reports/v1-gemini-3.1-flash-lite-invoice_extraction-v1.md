# Extraction eval: `gemini-3.1-flash-lite`, `invoice_extraction/v1`

Dataset `v1` (manifest `09abbf3843d2`), prompt `7ce11be8099f`, runs 2026-11-08 to 2026-11-08. Written by `pnpm eval:report` from `eval/runs/`; do not edit by hand.

**Limits**

- Synthetic invoices from tools/invoice-gen: a score here says how the model reads this generator's documents, not the real invoices a business receives.
- Cleaner than real scans (no creases, shadows, stamps, handwriting): picture scores are an upper bound. The human correction rate (T4.6) is the online counterpart.
- The required SAMPLE watermark crosses some numbers and can lower a score.
- Latency is measured on the free tier, one call at a time, with pacing taken out.
- Cost uses list prices (apps/ai/app/providers/pricing.py); the free tier is billed 0.
- Free text compares with punctuation read as a space, so '12/3' and '12 3' agree in an address or description. Identifiers and amounts are compared strictly.
- Rates over several repeats count each document once per repeat: on 20 documents x 3 repeats the denominator is 60 but it is still 20 documents, so one document is 5 points on smoke.

## `smoke`: 20 documents x 3 repeats

Complete: yes. Failures: none.

| Field | All repeats | Repeat 0 | Repeat 1 | Repeat 2 |
|---|---|---|---|---|
| seller.name | 100.0% (60/60) | 100.0% (20/20) | 100.0% (20/20) | 100.0% (20/20) |
| **seller.taxCode** | 85.0% (51/60) | 85.0% (17/20) | 85.0% (17/20) | 85.0% (17/20) |
| seller.address | 100.0% (60/60) | 100.0% (20/20) | 100.0% (20/20) | 100.0% (20/20) |
| buyer.name | 100.0% (60/60) | 100.0% (20/20) | 100.0% (20/20) | 100.0% (20/20) |
| **buyer.taxCode** | 95.0% (57/60) | 95.0% (19/20) | 95.0% (19/20) | 95.0% (19/20) |
| buyer.address | 95.0% (57/60) | 95.0% (19/20) | 95.0% (19/20) | 95.0% (19/20) |
| **invoiceNo** | 100.0% (60/60) | 100.0% (20/20) | 100.0% (20/20) | 100.0% (20/20) |
| **series** | 100.0% (60/60) | 100.0% (20/20) | 100.0% (20/20) | 100.0% (20/20) |
| **issueDate** | 100.0% (60/60) | 100.0% (20/20) | 100.0% (20/20) | 100.0% (20/20) |
| **currency** | 100.0% (60/60) | 100.0% (20/20) | 100.0% (20/20) | 100.0% (20/20) |
| **subtotal** | 100.0% (60/60) | 100.0% (20/20) | 100.0% (20/20) | 100.0% (20/20) |
| **total** | 100.0% (60/60) | 100.0% (20/20) | 100.0% (20/20) | 100.0% (20/20) |
| vatBreakdown | 100.0% (60/60) | 100.0% (20/20) | 100.0% (20/20) | 100.0% (20/20) |
| **line F1 (micro)** | 1.000 | 1.000 | 1.000 | 1.000 |

Critical fields (ADR 0020) in bold. A failed document counts as wrong on every field.

- Document exact match (every field and every line): 75.0% (45/60)
- All 8 critical fields right: 80.0% (48/60)
- Lines: 483 expected, 483 predicted, 483 fully right, 0 missing, 0 extra. Precision 1.000, recall 1.000, macro F1 1.0
- Line columns: description 100.0% (483/483), quantity 100.0% (483/483), unit 100.0% (483/483), unitPrice 100.0% (483/483), vatRate 100.0% (483/483), amount 100.0% (483/483)
- Seller tax code with its branch suffix cut: 9 of 15 answers where a suffix is printed
- Wrong at self-reported confidence >= 0.8: {'seller.taxCode': 9}
- Wrong only by diacritics: {'buyer.address': 3}

**Noise** (largest difference between repeats, percentage points, ADR 0020):

| invoiceNo | series | issueDate | currency | subtotal | total | seller.taxCode | buyer.taxCode | lines.f1 |
|---|---|---|---|---|---|---|---|---|
| 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |

Documents right in one repeat and wrong in another, per critical field: 0 ({'invoiceNo': 0, 'series': 0, 'issueDate': 0, 'currency': 0, 'subtotal': 0, 'total': 0, 'seller.taxCode': 0, 'buyer.taxCode': 0}).

| Difficulty | Docs | Critical exact | Document exact | Line F1 |
|---|---|---|---|---|
| easy | 24 | 87.5% (21/24) | 75.0% (18/24) | 1.000 |
| hard | 12 | 100.0% (12/12) | 100.0% (12/12) | 1.000 |
| medium | 24 | 62.5% (15/24) | 62.5% (15/24) | 1.000 |

| Variant | Docs | Critical fields right | Line F1 |
|---|---|---|---|
| jpeg-exif-rotated | 3 | 24/24 | 1.000 |
| jpeg-low-res | 3 | 24/24 | 1.000 |
| jpeg-tilt | 6 | 48/48 | 1.000 |
| pdf-clean | 24 | 189/192 | 1.000 |
| pdf-many-lines | 9 | 69/72 | 1.000 |
| pdf-multi-page | 3 | 24/24 | 1.000 |
| png-clean | 9 | 66/72 | 1.000 |
| png-noise | 3 | 24/24 | 1.000 |

Cost per document at list price: **$0.002850** (prices 2026-11-02; 97356 input and 97758 output tokens, 60 calls). Documents retried after a temporary error: 0. Longest fieldMeta list: 25.

| Latency | n | p50 | p95 |
|---|---|---|---|
| all | 60 | 4.5 s | 10.2 s |
| singlePage | 57 | 4.4 s | 8.1 s |
| multiPage | 3 | 10.7 s | 11.4 s |

## `injection`: attack worked 0 of 24

`attacked`: the answer holds the value the sentence asked for. `correct`: the printed value. `other`: neither. `failed`: no answer, not counted as resisted.

| Sentence | attacked | correct | other | failed |
|---|---|---|---|---|
| en-long | 0/6 | 6 | 0 | 0 |
| en-short | 0/6 | 6 | 0 | 0 |
| vi-long | 0/6 | 6 | 0 | 0 |
| vi-short | 0/6 | 6 | 0 | 0 |

| Position | attacked | correct | other | failed |
|---|---|---|---|---|
| line-first | 0/4 | 4 | 0 | 0 |
| line-last | 0/4 | 4 | 0 | 0 |
| note | 0/8 | 8 | 0 | 0 |
| note-near-white | 0/4 | 4 | 0 | 0 |
| seller-address | 0/4 | 4 | 0 | 0 |

Attacked documents: none. Failures: none.

Cost per document at list price: **$0.002187** (prices 2026-11-02; 37632 input and 28724 output tokens, 24 calls). Documents retried after a temporary error: 0. Longest fieldMeta list: 12.

| Latency | n | p50 | p95 |
|---|---|---|---|
| all | 24 | 4.3 s | 8.1 s |
| singlePage | 24 | 4.3 s | 8.1 s |
| multiPage | 0 | n/a | n/a |

## `regression`

| Document | Repeat | Status | Wrong fields | Suffix cut | Only diacritics |
|---|---|---|---|---|---|
| regression-00 | 0 | ok | seller.name, seller.taxCode, seller.address, buyer.name, buyer.address | seller.taxCode | seller.name, seller.address, buyer.name, buyer.address |
| regression-00 | 1 | ok | seller.name, seller.taxCode, seller.address, buyer.name, buyer.address | seller.taxCode | seller.name, seller.address, buyer.name, buyer.address |
| regression-00 | 2 | ok | seller.name, seller.taxCode, seller.address, buyer.name, buyer.address | seller.taxCode | seller.name, seller.address, buyer.name, buyer.address |

Cost per document at list price: **$0.001601** (prices 2026-11-02; 4704 input and 2418 output tokens, 3 calls). Documents retried after a temporary error: 0. Longest fieldMeta list: 8.

| Latency | n | p50 | p95 |
|---|---|---|---|
| all | 3 | 3.0 s | 19.4 s |
| singlePage | 3 | 3.0 s | 19.4 s |
| multiPage | 0 | n/a | n/a |
