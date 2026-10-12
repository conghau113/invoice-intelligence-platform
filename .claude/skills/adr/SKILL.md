---
name: adr
description: Create a new Architecture Decision Record (lightweight MADR) from the template, and register it in the ADR index.
disable-model-invocation: true
---
Topic: $ARGUMENTS

1. Read `docs/architecture/adr/README.md` and `0000-template.md`. Next number = highest existing + 1.
2. Ask Hậu for anything you do not know (context, constraints, which option he prefers). Never invent reasons or numbers; cite measurements from `eval/reports` or `docs/reports` when they exist.
3. Write `docs/architecture/adr/NNNN-short-slug.md` in English following the template; at least 2 options and explicit trade-offs; "Revisit when" must name a concrete signal.
4. If it replaces an older ADR, set the old one's status to "Superseded by ADR NNNN" (do not rewrite its decision).
5. Add the row to the index table in `README.md`. Run the ADR index check if it exists.
