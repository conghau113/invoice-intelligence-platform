# invoice-gen

Synthetic invoices with a known answer, for evaluating extraction (M4). Data is synthetic by
construction (`docs/LEGAL.md`): tax codes get a wrong check digit, every company and person name ends
in `SAMPLE`, every rendered page carries `SAMPLE – SYNTHETIC DATA`. Never commit real invoices.

## Generate and check

```bash
pnpm gen:invoices --n 100 --seed 42   # writes tools/invoice-gen/out/ (git-ignored, old dataset replaced)
pnpm gen:invoices:verify              # checks those files; exit 1 on any problem
pnpm test:invoice-gen                 # browser tests (also part of `pnpm check:full`, not of CI)
```

A plain `pytest tests/test_invoice_gen_render.py` deselects everything and exits with code 5: use the
command above.

Needs Chromium: `pnpm --filter web exec playwright install chromium`. 100 documents take about a
minute and 14 MB.

## What comes out

| File                    | Content                                                                   |
| ----------------------- | ------------------------------------------------------------------------- |
| `<id>.expected.json`    | Ground truth: a full `Invoice` with an empty `fieldMeta`                  |
| `<id>.xml`              | The same invoice as XML, in the structure the parser supports (see below) |
| `<id>.pdf`              | The same invoice, rendered                                                |
| `<id>.png` / `<id>.jpg` | Only for the picture variants: the same page, degraded                    |
| `manifest.json`         | `difficulty`, `variant`, `layout`, `pages`, `primary`, hash of each file  |

`primary` is the file to feed the pipeline. It has no timestamp, so two runs give the same manifest.

| Difficulty     | Position (`i % 5`) | Variants                                                                                                                                 |
| -------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| easy (40%)     | 0, 2               | `pdf-clean`                                                                                                                              |
| medium (40%)   | 1, 3               | `pdf-many-lines`, `png-clean`, `jpeg-tilt`                                                                                               |
| hard (20%)     | 4                  | `pdf-multi-page`, `jpeg-tilt-noise`, `jpeg-low-res`, `png-noise`, `jpeg-exif-rotated` (pixels stored sideways, EXIF `Orientation` 6)     |

Layouts: `vn-classic`, `vn-modern`, `vn-compact` (Vietnamese, totals above the lines), `en-standard`,
`en-ledger` (English). Companies come from a small fixed pool, so they repeat across invoices and
questions like "how much did we pay X in September" have an answer (M5). One seller in four has a
branch tax code (`0123456789-001`).

## Repeatability

Document `i` depends only on `(seed, i)`, so `--n 50` gives the first 50 documents of `--n 100`.
Nothing reads the clock, the browser is offline, and fonts are committed in `fonts/`. Chromium writes
the time into each PDF: `normalize_pdf_dates` replaces it and stops the run if the format changes.

"The same bytes" is tested on one machine with one Chromium build. Do not expect it across machines
or browser upgrades: rasterising can differ. T4.2 fixes the dataset by hash, so eval never has to
regenerate it. Faker, Jinja and Playwright are pinned, because a new version can change the output;
keep `playwright` in `apps/ai/pyproject.toml` equal to `@playwright/test` in `apps/web`, so both use
the same Chromium.

## What `verify` checks

It reads the written files and computes the check digit on its own, so a generator bug cannot hide
in its checker. Output is document ids and fixed codes, never document content.

- No tax code passes the check digit, in the ground truth or anywhere on the PDF.
- Every name ends in `SAMPLE`; every PDF page has the watermark (rotated text is read separately).
- The XML goes through the real parser and equals the ground truth.
- The ground truth passes the pydantic model, and the Zod schema and rules with no warning
  (`check-rules.mjs`).
- The answer is on the page: an eval must not blame the model for a template that hides a field.
- Files match the manifest; PDFs use only the committed fonts.
- Each document fits the real limits of `apps/ai` (pages, bytes) by calling its code.
- A picture comes from a one-page document, otherwise it would miss lines the answer still has.

A picture has no text to read back, so the fit and the watermark are checked in the browser:
rendering stops if the mark is missing or if hiding it does not change the picture. That proves some
of the mark shows, not all of it; there is no OCR on the final file.

Not caught: a tax code printed with spaces or dots inside it (`0123 456 789`). No template prints
one, and scanning for it would also match prices in neighbouring cells. A wrapped ground-truth code
is caught (`TAX_CODE_SPLIT_ON_PAGE`).

## XML structure the parser supports

A subset of the public Vietnamese e-invoice element names:

```text
HDon/DLHDon
  TTChung: KHHDon (series) SHDon (number) NLap (YYYY-MM-DD) DVTTe (VND | USD)
  NDHDon
    NBan, NMua: Ten MST DChi        (NMua/MST may be absent => buyer.taxCode null)
    DSHHDVu/HHDVu*: THHDVu DVTinh SLuong DGia TSuat ThTien
    TToan: THTTLTSuat/LTSuat*: TSuat TgTien TThue ; TgTCThue (subtotal) ; TgTTTBSo (total)
```

Money is decimal text and becomes integer minor units (VND exponent 0, USD 2). `TSuat` is `10%`
or `10`.

## Limits

- Cleaner than real scans: no creases, shadows, perspective, stamps or handwriting. Accuracy measured
  on this data is an upper bound, and reports must say so.
- XML passing the parser shows the parser matches this generator, not that it reads real files. Real
  provider files differ per supplier: namespaces, optional fields, `KCT` (not subject to tax), other
  currencies, signature blocks. The parser refuses what it does not know with a stable code
  (`XML_UNSUPPORTED_STRUCTURE`, `XML_UNSUPPORTED_VAT_RATE`, `XML_UNSUPPORTED_CURRENCY`) instead of
  guessing. To support a new provider, add its element paths in `_map`
  (`apps/ai/app/services/xml_invoice.py`), add a generated sample, and extend the ground-truth test.
- VND and USD only, because that is what the XML path supports.
- The watermark crosses some numbers. `docs/LEGAL.md` requires it; it can lower measured accuracy.

## Older minimal generators

These stay because tests compare their committed fixtures byte by byte. New data comes from
`generate.py`.

```bash
cd apps/ai
uv run python ../../tools/invoice-gen/min_xml.py --n 10 --seed 42   # T2.8: tests/fixtures/xml_invoices
uv run python ../../tools/invoice-gen/min_pdf.py --n 3              # T3.1: tests/fixtures/pdf_invoices
uv run python ../../tools/invoice-gen/min_injection.py              # T3.6: tests/fixtures/injection
```

`min_injection.py` also writes `packages/contracts/fixtures/injection.obeyed-*.json`, what a model
that obeyed the attack would answer. After changing the data of `generate.py`, rewrite its samples in
`packages/contracts/fixtures/generated/` with
`uv run --project apps/ai python tools/invoice-gen/generate.py --write-golden`.

## Fonts

`fonts/` holds Tinos and Arimo (SIL Open Font License 1.1, `fonts/OFL-*.txt`) from `@fontsource` 5.3.0.
They are only used here and are embedded into the generated files. See `docs/LEGAL.md`.
