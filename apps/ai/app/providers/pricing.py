"""Versioned price table (USD per 1M tokens). Prices change: edit this table, never the logic.

Sources, read 2026-11-08: https://aistudio.google.com/docs/pricing (Gemini paid-tier standard rates,
text/image input, output includes thinking) and https://openrouter.ai/api/v1/models (the paid route
of the OpenRouter fallback measured in T4.4; its `:free` route costs 0). The free tiers cost 0 but
we record the list price so M4 can compare. The 3.6 and 3.8 Flash prices double on 2027-01-01: a
report written after that date must use the new row.
"""

PRICES_VERSION = "2026-11-08"

# model -> (input USD / 1M tokens, output USD / 1M tokens)
PRICES: dict[str, tuple[float, float]] = {
    "gemini-3.8-flash": (0.75, 3.75),
    "gemini-3.6-flash": (0.75, 3.75),
    "gemini-3.5-flash-lite": (0.30, 2.50),
    "gemini-3.1-flash-lite": (0.25, 1.50),
    "gemini-2.5-flash": (0.30, 2.50),
    "gemini-2.5-flash-lite": (0.10, 0.40),
    # List price of the paid route, recorded for the free route so M4 can compare (T4.4, ADR 0009)
    "nvidia/nemotron-3.5-super-vl:free": (0.15, 0.50),
    "fake-model": (1.00, 4.00),
}


def estimate_cost_usd(model: str, input_tokens: int, output_tokens: int) -> float:
    """Unknown model => 0.0, not a guess: a made-up price would look like a measurement."""
    price = PRICES.get(model)
    if price is None:
        return 0.0
    return round((input_tokens * price[0] + output_tokens * price[1]) / 1_000_000, 6)
