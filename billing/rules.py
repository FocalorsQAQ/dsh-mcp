"""User-editable billing rules. Python 3.10+, standard library only.

Prices are per million tokens. Money returned to the host is integer nanounits
(1 currency unit = 1_000_000_000), always [USD, CNY]. No exchange conversion.
Keep quote() conservative enough to cover every possible settle() outcome.
Print diagnostics to stderr, never stdout (reserved for the JSON protocol).
"""
from decimal import Decimal, ROUND_CEILING


OFF_PEAK_MULTIPLIER = Decimal("0.5")
# Optional overrides by model, then currency; otherwise billing/prices.json applies.
# Example: {"deepseek-v4-flash": {"USD": ["0.3", "0.006", "1.2"]}}
RATE_OVERRIDES = {}


def charge(usage, rates, currency):
    tokens = (usage["input_cache_miss"], usage["input_cache_hit"], usage["output"])
    amount = sum(Decimal(n) * Decimal(str(rate)) * 1000 for n, rate in zip(tokens, rates))
    nano = int(amount.to_integral_value(rounding=ROUND_CEILING))
    return [nano, 0] if currency == "USD" else [0, nano]


def quote(request):
    """Reserve full cache-miss context at peak rates; cap output to the budget.

    For nonlinear pricing, replace this search with your own conservative bound.
    All settlement parameters must be copied into context for this request.
    """
    currency = request["currency"]
    rates = RATE_OVERRIDES.get(request["model"], {}).get(currency, request["rates"])
    rates = [str(Decimal(str(rate))) for rate in rates]
    available = request["available_nano"]
    limit = request["max_tokens"]

    def reservation(output):
        return charge({"input_cache_miss": request["input_limit"], "input_cache_hit": 0, "output": output}, rates, currency)

    def fits(output):
        return available is None or all(a <= b for a, b in zip(reservation(output), available))

    if not fits(1):
        return {"error": "BUDGET_RESERVATION"}
    lo, hi = 1, limit
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if fits(mid):
            lo = mid
        else:
            hi = mid - 1
    return {"max_tokens": lo, "reserved_nano": reservation(lo),
            "rates": [float(rate) for rate in rates],
            "context": {"rates": rates, "off_peak_multiplier": str(OFF_PEAK_MULTIPLIER)}}


def settle(request):
    """Only called for a complete, validated token receipt.

    The host handles rejection, unknown receipts, retries and ledger persistence.
    period is the host's timezone-aware conservative peak/off_peak/mixed/unknown
    classification. Custom rules may classify started_at/finished_at themselves.
    """
    context = request["context"]
    period = request["period"]
    multiplier = Decimal(context["off_peak_multiplier"]) if period == "off_peak" else Decimal(1)
    rates = [Decimal(rate) * multiplier for rate in context["rates"]]
    return {"cost_nano": charge(request["usage"], rates, request["currency"]),
            "settled_rates": [float(rate) for rate in rates], "pricing_period": period,
            "cost_basis": "time_of_use_estimate" if period in ("peak", "off_peak") else "peak_upper_bound"}
