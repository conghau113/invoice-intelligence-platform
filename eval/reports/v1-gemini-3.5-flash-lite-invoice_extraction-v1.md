# Extraction eval: `gemini-3.5-flash-lite`, `invoice_extraction/v1`

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
| seller.name | 95.0% (57/60) | 95.0% (19/20) | 95.0% (19/20) | 95.0% (19/20) |
| **seller.taxCode** | 93.3% (56/60) | 95.0% (19/20) | 95.0% (19/20) | 90.0% (18/20) |
| seller.address | 98.3% (59/60) | 95.0% (19/20) | 100.0% (20/20) | 100.0% (20/20) |
| buyer.name | 100.0% (60/60) | 100.0% (20/20) | 100.0% (20/20) | 100.0% (20/20) |
| **buyer.taxCode** | 100.0% (60/60) | 100.0% (20/20) | 100.0% (20/20) | 100.0% (20/20) |
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

- Document exact match (every field and every line): 81.7% (49/60)
- All 8 critical fields right: 93.3% (56/60)
- Lines: 483 expected, 483 predicted, 483 fully right, 0 missing, 0 extra. Precision 1.000, recall 1.000, macro F1 1.0
- Line columns: description 100.0% (483/483), quantity 100.0% (483/483), unit 100.0% (483/483), unitPrice 100.0% (483/483), vatRate 100.0% (483/483), amount 100.0% (483/483)
- Seller tax code with its branch suffix cut: 4 of 15 answers where a suffix is printed
- Wrong at self-reported confidence >= 0.8: {'seller.taxCode': 4}
- Wrong only by diacritics: {'seller.address': 1}

**Noise** (largest difference between repeats, percentage points, ADR 0020):

| invoiceNo | series | issueDate | currency | subtotal | total | seller.taxCode | buyer.taxCode | lines.f1 |
|---|---|---|---|---|---|---|---|---|
| 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 5.0 | 0.0 | 0.0 |

Documents right in one repeat and wrong in another, per critical field: 1 ({'invoiceNo': 0, 'series': 0, 'issueDate': 0, 'currency': 0, 'subtotal': 0, 'total': 0, 'seller.taxCode': 1, 'buyer.taxCode': 0}).

| Difficulty | Docs | Critical exact | Document exact | Line F1 |
|---|---|---|---|---|
| easy | 24 | 100.0% (24/24) | 75.0% (18/24) | 1.000 |
| hard | 12 | 100.0% (12/12) | 91.7% (11/12) | 1.000 |
| medium | 24 | 83.3% (20/24) | 83.3% (20/24) | 1.000 |

| Variant | Docs | Critical fields right | Line F1 |
|---|---|---|---|
| jpeg-exif-rotated | 3 | 24/24 | 1.000 |
| jpeg-low-res | 3 | 24/24 | 1.000 |
| jpeg-tilt | 6 | 48/48 | 1.000 |
| pdf-clean | 24 | 192/192 | 1.000 |
| pdf-many-lines | 9 | 69/72 | 1.000 |
| pdf-multi-page | 3 | 24/24 | 1.000 |
| png-clean | 9 | 71/72 | 1.000 |
| png-noise | 3 | 24/24 | 1.000 |

Cost per document at list price: **$0.004986** (prices 2026-11-08; 97356 input and 107971 output tokens, 66 calls). Documents retried after a temporary error: 2. Longest fieldMeta list: 61.

| Latency | n | p50 | p95 |
|---|---|---|---|
| all | 60 | 4.2 s | 7.8 s |
| singlePage | 57 | 4.2 s | 7.5 s |
| multiPage | 3 | 16.2 s | 16.9 s |

## `core`: 100 documents x 1 repeats

Complete: yes. Failures: {'rejected:EXTRACTION_SCHEMA_INVALID': 1}.

| Field | All repeats | Repeat 0 |
|---|---|---|
| seller.name | 97.0% (97/100) | 97.0% (97/100) |
| **seller.taxCode** | 92.0% (92/100) | 92.0% (92/100) |
| seller.address | 99.0% (99/100) | 99.0% (99/100) |
| buyer.name | 99.0% (99/100) | 99.0% (99/100) |
| **buyer.taxCode** | 99.0% (99/100) | 99.0% (99/100) |
| buyer.address | 95.0% (95/100) | 95.0% (95/100) |
| **invoiceNo** | 99.0% (99/100) | 99.0% (99/100) |
| **series** | 99.0% (99/100) | 99.0% (99/100) |
| **issueDate** | 99.0% (99/100) | 99.0% (99/100) |
| **currency** | 99.0% (99/100) | 99.0% (99/100) |
| **subtotal** | 99.0% (99/100) | 99.0% (99/100) |
| **total** | 99.0% (99/100) | 99.0% (99/100) |
| vatBreakdown | 99.0% (99/100) | 99.0% (99/100) |
| **line F1 (micro)** | 0.943 | 0.943 |

Critical fields (ADR 0020) in bold. A failed document counts as wrong on every field.

- Document exact match (every field and every line): 85.0% (85/100)
- All 8 critical fields right: 92.0% (92/100)
- Lines: 660 expected, 606 predicted, 597 fully right, 54 missing, 0 extra. Precision 0.985, recall 0.904, macro F1 0.978
- Line columns: description 91.7% (605/660), quantity 90.6% (598/660), unit 91.8% (606/660), unitPrice 90.6% (598/660), vatRate 91.8% (606/660), amount 91.8% (606/660)
- Seller tax code with its branch suffix cut: 7 of 26 answers where a suffix is printed
- Wrong at self-reported confidence >= 0.8: {'seller.taxCode': 7}
- Wrong only by diacritics: {'buyer.address': 1}

| Difficulty | Docs | Critical exact | Document exact | Line F1 |
|---|---|---|---|---|
| easy | 40 | 92.5% (37/40) | 82.5% (33/40) | 0.992 |
| hard | 20 | 90.0% (18/20) | 80.0% (16/20) | 0.858 |
| medium | 40 | 92.5% (37/40) | 90.0% (36/40) | 1.000 |

| Variant | Docs | Critical fields right | Line F1 |
|---|---|---|---|
| jpeg-exif-rotated | 4 | 32/32 | 1.000 |
| jpeg-low-res | 4 | 32/32 | 1.000 |
| jpeg-tilt | 13 | 104/104 | 1.000 |
| jpeg-tilt-noise | 4 | 32/32 | 0.704 |
| pdf-clean | 40 | 317/320 | 0.992 |
| pdf-many-lines | 14 | 109/112 | 1.000 |
| pdf-multi-page | 4 | 24/32 | 0.830 |
| png-clean | 13 | 104/104 | 1.000 |
| png-noise | 4 | 31/32 | 1.000 |

Cost per document at list price: **$0.004519** (prices 2026-11-08; 161168 input and 161423 output tokens, 100 calls). Documents retried after a temporary error: 0. Longest fieldMeta list: 58.

| Latency | n | p50 | p95 |
|---|---|---|---|
| all | 99 | 4.5 s | 10.7 s |
| singlePage | 96 | 4.5 s | 7.1 s |
| multiPage | 3 | 14.7 s | 15.9 s |

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

Cost per document at list price: **$0.003651** (prices 2026-11-08; 39200 input and 30346 output tokens, 26 calls). Documents retried after a temporary error: 1. Longest fieldMeta list: 12.

| Latency | n | p50 | p95 |
|---|---|---|---|
| all | 24 | 4.0 s | 5.0 s |
| singlePage | 24 | 4.0 s | 5.0 s |
| multiPage | 0 | n/a | n/a |

## `regression`

| Document | Repeat | Status | Wrong fields | Suffix cut | Only diacritics |
|---|---|---|---|---|---|
| regression-00 | 0 | ok | seller.name, seller.address, buyer.name, buyer.address | - | seller.name, seller.address, buyer.name, buyer.address |

Cost per document at list price: **$0.004360** (prices 2026-11-08; 1568 input and 1556 output tokens, 1 calls). Documents retried after a temporary error: 0. Longest fieldMeta list: 21.

| Latency | n | p50 | p95 |
|---|---|---|---|
| all | 1 | 4.4 s | 4.4 s |
| singlePage | 1 | 4.4 s | 4.4 s |
| multiPage | 0 | n/a | n/a |
