# Extraction eval: `nvidia/nemotron-3.5-super-vl:free`, `invoice_extraction/v1`

Dataset `v1` (manifest `09abbf3843d2`), prompt `7ce11be8099f`, runs 2026-11-08 to 2026-11-08. Written by `pnpm eval:report` from `eval/runs/`; do not edit by hand.

**Limits**

- Synthetic invoices from tools/invoice-gen: a score here says how the model reads this generator's documents, not the real invoices a business receives.
- Cleaner than real scans (no creases, shadows, stamps, handwriting): picture scores are an upper bound. The human correction rate (T4.6) is the online counterpart.
- The required SAMPLE watermark crosses some numbers and can lower a score.
- Latency is measured on the free tier, one call at a time, with pacing taken out.
- Cost uses list prices (apps/ai/app/providers/pricing.py); the free tier is billed 0.
- Free text compares with punctuation read as a space, so '12/3' and '12 3' agree in an address or description. Identifiers and amounts are compared strictly.
- Rates over several repeats count each document once per repeat: on 20 documents x 3 repeats the denominator is 60 but it is still 20 documents, so one document is 5 points on smoke.

## `core`: 100 documents x 1 repeats

Complete: NO: missing 51, or not final. Failures: {'rejected:EXTRACTION_SCHEMA_INVALID': 3}.

| Field | All repeats | Repeat 0 |
|---|---|---|
| seller.name | 75.5% (37/49) | 75.5% (37/49) |
| **seller.taxCode** | 93.9% (46/49) | 93.9% (46/49) |
| seller.address | 63.3% (31/49) | 63.3% (31/49) |
| buyer.name | 83.7% (41/49) | 83.7% (41/49) |
| **buyer.taxCode** | 91.8% (45/49) | 91.8% (45/49) |
| buyer.address | 73.5% (36/49) | 73.5% (36/49) |
| **invoiceNo** | 91.8% (45/49) | 91.8% (45/49) |
| **series** | 93.9% (46/49) | 93.9% (46/49) |
| **issueDate** | 93.9% (46/49) | 93.9% (46/49) |
| **currency** | 93.9% (46/49) | 93.9% (46/49) |
| **subtotal** | 93.9% (46/49) | 93.9% (46/49) |
| **total** | 93.9% (46/49) | 93.9% (46/49) |
| vatBreakdown | 93.9% (46/49) | 93.9% (46/49) |
| **line F1 (micro)** | 0.654 | 0.654 |

Critical fields (ADR 0020) in bold. A failed document counts as wrong on every field.

- Document exact match (every field and every line): 38.8% (19/49)
- All 8 critical fields right: 89.8% (44/49)
- Lines: 351 expected, 233 predicted, 191 fully right, 118 missing, 0 extra. Precision 0.820, recall 0.544, macro F1 0.7667
- Line columns: description 59.5% (209/351), quantity 66.4% (233/351), unit 59.0% (207/351), unitPrice 66.1% (232/351), vatRate 66.4% (233/351), amount 66.4% (233/351)
- Seller tax code with its branch suffix cut: 0 of 13 answers where a suffix is printed
- Wrong at self-reported confidence >= 0.8: {'invoiceNo': 1, 'buyer.taxCode': 1}
- Wrong only by diacritics: {'buyer.address': 5, 'seller.address': 11, 'buyer.name': 4, 'seller.name': 7}

| Difficulty | Docs | Critical exact | Document exact | Line F1 |
|---|---|---|---|---|
| easy | 20 | 95.0% (19/20) | 45.0% (9/20) | 0.821 |
| hard | 9 | 77.8% (7/9) | 22.2% (2/9) | 0.360 |
| medium | 20 | 90.0% (18/20) | 40.0% (8/20) | 0.782 |

| Variant | Docs | Critical fields right | Line F1 |
|---|---|---|---|
| jpeg-exif-rotated | 1 | 8/8 | 1.000 |
| jpeg-low-res | 2 | 16/16 | 0.500 |
| jpeg-tilt | 6 | 48/48 | 0.769 |
| jpeg-tilt-noise | 2 | 16/16 | 0.938 |
| pdf-clean | 20 | 159/160 | 0.821 |
| pdf-many-lines | 7 | 48/56 | 0.748 |
| pdf-multi-page | 2 | 0/16 | 0.000 |
| png-clean | 7 | 55/56 | 0.871 |
| png-noise | 2 | 16/16 | 0.800 |

Cost per document at list price: **$0.002484** (prices 2026-11-08; 136857 input and 202393 output tokens, 49 calls). Documents retried after a temporary error: 0. Longest fieldMeta list: 23.

| Latency | n | p50 | p95 |
|---|---|---|---|
| all | 46 | 22.2 s | 64.3 s |
| singlePage | 46 | 22.2 s | 64.3 s |
| multiPage | 0 | n/a | n/a |
