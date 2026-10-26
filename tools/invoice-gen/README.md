# invoice-gen

Synthetic invoice generator. Today only the minimal XML generator from T2.8 exists; T4.1 adds Faker,
PDF/image rendering and hard variants.

```bash
cd apps/ai && uv run python ../../tools/invoice-gen/min_xml.py --n 10 --seed 42
```

Writes `invoice-NN.xml` and `invoice-NN.expected.json` (ground truth) to
`apps/ai/tests/fixtures/xml_invoices/`. The same seed gives the same bytes; a test regenerates them
and compares with the committed files. Data is synthetic: tax codes get a wrong check digit and
names carry `SAMPLE` (docs/LEGAL.md). Never commit real invoices.

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

Real provider files differ per supplier: namespaces, optional fields, `KCT` (not subject to tax),
other currencies, signature blocks. The parser refuses what it does not know with a stable code
(`XML_UNSUPPORTED_STRUCTURE`, `XML_UNSUPPORTED_VAT_RATE`, `XML_UNSUPPORTED_CURRENCY`) instead of
guessing. To support a new provider, add its element paths in `_map`
(`apps/ai/app/services/xml_invoice.py`), add a generated sample, and extend the ground-truth test.
