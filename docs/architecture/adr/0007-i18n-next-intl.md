# ADR 0007: Internationalization with next-intl and locale-prefixed routes

- Status: Accepted
- Date: 2026-10-11

## Context
The product targets Vietnamese and international users from day one (vi, en). Money/date formats differ by locale.

## Options considered
1. next-intl
2. react-i18next
3. Custom dictionary

## Decision criteria
- App Router + Server Components support
- ICU message format (plurals)
- Type safety of keys

## Decision
next-intl with `app/[locale]` routing, `messages/{vi,en}.json`, ICU messages, `Intl` formatters; CI script enforces key parity.

## Consequences
- + Works in Server Components
- + Plurals and interpolation handled correctly
- − Locale in every URL (acceptable, good for sharing)

## Revisit when
Adding a third language only requires a messages file and parity check update.
