# Design baseline (T1.6b)

One palette, one font pair, one spacing scale, shared patterns. Every business page reuses these; page-specific design is out of scope. Live reference: `/vi/styleguide` and `/en/styleguide` (needs sign-in like every page), source in `apps/web/src/features/styleguide/`.

## How it was produced

The skill `ui-ux-pro-max` (MIT, `.claude/skills/ui-ux-pro-max/`, one copy) holds searchable palettes and font pairings. Query: *B2B SaaS dashboard, invoice, data-dense, accounting*.

- Palette row **"Invoice & Billing Tool"** (`data/colors.csv` #105): navy primary `#1E3A5F`, blue secondary `#2563EB`, "paid" green `#059669`, neutral slate surfaces. The product row (`products.csv` #105) recommends Minimalism/Swiss style with a data-dense financial dashboard and status badges (Draft/Sent/Paid/Overdue), which matches our document statuses.
- Font row **"Financial Trust"** (`data/typography.csv` #31): IBM Plex Sans. We add IBM Plex Mono for amounts, tax codes and invoice numbers. Both have a `vietnamese` subset (`data/google-fonts.csv`), required for names like "Nguyễn".
- Ran on 2026-10-18: `python3 search.py "B2B SaaS dashboard invoice data-dense accounting" --design-system -p "Invoice Intelligence"` (run from `scripts/`; the owner ran it first, then the agent re-ran it with the exact query and got the same output; the owner's pasted command line lost a space to a copy artifact). Our choice came from the product-specific CSV rows above, then was compared with the generator output below.

### Generator output vs what we chose

| Item | Generator | We chose | Why |
|---|---|---|---|
| Style | Dark Mode (OLED), "light not recommended" | Light default + dark, Minimalism/Swiss | Spec requires light and dark. Accountants read tables for hours in daylight offices; the product row for invoices recommends Minimalism/Swiss |
| Pattern | Enterprise Gateway (marketing landing page: hero, client logos, Contact Sales) | none | It is a landing-page pattern; this is an in-app dashboard, out of scope here |
| Colours | Slate `#0F172A`/`#020617` surfaces, green `#22C55E` accent, `#EF4444` destructive | Navy `#1E3A5F` + slate, green only for "approved" | The slate surfaces match our dark theme in spirit; `#22C55E` and `#EF4444` fail 4.5:1 as text on light, so semantic colours are darkened for light and kept bright for dark |
| Fonts | Fira Code / Fira Sans | IBM Plex Sans / Plex Mono | Fira Code has **no Vietnamese subset** (`data/google-fonts.csv`), so amounts and names with diacritics would fall back. Fira Sans has one. Plex covers both |
| Checklist | visible focus, reduced motion, contrast 4.5:1, 375/768/1024/1440 widths | same, except widths | Focus, reduced motion and contrast are done and tested; responsive widths are not tested yet (T1.7 shell) |

## Why these colours (criteria, in order)

1. **Contrast first.** WCAG 2.x AA: text 4.5:1, borders and focus ring 3:1. `apps/web/src/styles/contrast.test.ts` reads `tokens.css` and fails the build if any pair drops below it, for light and dark.
2. **Trust and calm for money screens.** Navy and slate, little saturation; colour is kept for meaning (status), not decoration.
3. **Meaning is never colour alone.** Each status has a word and an icon (`status-badge.tsx`).

Three values differ from the raw skill palette, for different reasons: (1) "paid green" `#059669` is only 3.8:1 as text on white, so `--success` is `#047857` (5.5:1); we darkened it up front and `contrast.test.ts` has a negative case proving the raw value fails. (2) The input border `#94a3b8` was 2.5:1: this is the one the test actually caught, so `--input` is `#64748b`. (3) `--destructive` is `#b91c1c` instead of `#DC2626`: the raw value passes on the page background (4.6:1) but leaves little margin on tinted surfaces, so it was darkened for headroom, not because a test failed.

## Tokens (`apps/web/src/styles/tokens.css`)

CSS variables on `:root` (light) and `.dark`. Names follow shadcn (`--background`, `--primary`, `--ring`, `--sidebar-*`) so `components/ui` works unchanged; we add `--success`, `--warning`, `--info` and `-soft` pairs for badges and warnings (T3.4 uses `warning` for low-confidence fields). Components use Tailwind utilities (`bg-card`, `text-muted-foreground`), which read the variables, so changing a colour is one edit and dark mode needs no per-component code.

| Pair (text / background) | Light | Dark |
|---|---|---|
| `foreground` / `background` | 17.1 | 15.4 |
| `primary-foreground` / `primary` | 11.5 | 8.8 |
| `muted-foreground` / `background` | 7.2 | 8.3 |
| `destructive` / `background` | 6.2 | 6.8 |
| `success` / `card` | 5.5 | 9.1 |
| `warning` / `card` | 5.0 | 10.4 |
| `info` / `card` | 6.7 | 6.8 |
| `*-soft-foreground` / `*-soft` | 8.1 to 8.6 | 8.1 to 8.6 |
| `ring` / `background` (3:1 needed) | 4.9 | 7.4 |
| `input` / `card` (3:1 needed) | 4.8 | 3.7 |

## Type, spacing, shape

- Fonts: `--font-sans` = IBM Plex Sans (400, 500, 600, 700), `--font-mono` = IBM Plex Mono (400, 500), loaded with `next/font/google` (downloaded at build, self-hosted by Next, no request to Google at runtime). Use `font-mono` and `tabular-nums` for numbers in tables.
- Spacing: Tailwind's 4px grid (`--spacing: 0.25rem`); common steps 1, 2, 3, 4, 6, 8, 12, 16 (4 to 64px). Table row height `--row-height` = 2.5rem; page width `--content-max` = 80rem.
- Shape: `--radius` 0.5rem.

## Theme

Cookie `theme` = `light` or `dark` (default light). The server reads it in `[locale]/layout.tsx` and puts class `dark` on `<html>`, so there is no flash; `ThemeToggle` flips the class and rewrites the cookie. Any other cookie value is treated as light (`src/lib/theme.ts`). Reading the cookie makes pages render per request.

## Shared patterns (`apps/web/src/components/`)

| Pattern | File | Notes |
|---|---|---|
| Data table | `common/data-table.tsx` | Required caption (screen reader), `scope="col"`, right-aligned tabular figures for amounts. Sorting and paging belong to T2.6 |
| Form field | `common/form-field.tsx` | Label `htmlFor`, hint and error linked with `aria-describedby`, `aria-invalid` |
| Loading / empty / error | `common/state-panel.tsx` | `role="status"` + `aria-busy`, nothing, `role="alert"` |
| Document status badge | `common/status-badge.tsx` | Seven statuses of the state machine (ARCHITECTURE section 8) |
| Theme toggle | `common/theme-toggle.tsx` | `aria-pressed` and a translated `aria-label` |
| Primitives | `ui/{button,badge,input,label,table,skeleton}.tsx` | shadcn style, token colours |

Strings are in `messages/{vi,en}.json` under `Styleguide`, `Status`, `Theme`.

## Accessibility checklist

- [x] Text contrast at least 4.5:1, UI boundaries and focus ring at least 3:1 (tested, light and dark).
- [x] Every input has a `<label>`; hints and errors are tied to it.
- [x] Keyboard: skip link to `#content`, natural Tab order, visible focus ring (`focus-visible:ring-3 ring-ring`) on buttons and inputs.
- [x] Status never conveyed by colour alone.
- [x] Loading/error announced (`role="status"`, `role="alert"`); skeleton motion respects `prefers-reduced-motion`.
- [x] `<html lang>` follows the locale.
- [x] Lighthouse Accessibility at least 90: measured 100 on `/vi/styleguide` and `/en/styleguide`, light and dark (Lighthouse 13.5.0, production build, 2026-10-18). Keyboard walk with Playwright: skip link, language, theme, buttons, inputs, retry, all with a visible focus ring.

## For later tasks

- T1.7 (app shell): use `--sidebar-*`, `ThemeToggle`, `LanguageSwitcher`; layout width `--content-max`.
- T2.5, T2.6: `DataTable`, `StatusBadge`, `StatePanel`.
- T3.4: `FormField`, `warning` tokens for low-confidence fields.
- T7.6: Lighthouse CI will re-measure LCP, CLS and INP; the theme cookie makes the layout dynamic.
