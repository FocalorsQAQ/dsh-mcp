"""Example: charge 0.01 of the selected currency for each successful API call.

Set billing.rules to this file to try it with local test traffic. This example
does NOT describe DeepSeek's actual prices. No charge for explicit rejection;
unknown outcomes retain the reservation, as enforced by the host.
"""
FEE_NANO = 10_000_000


def quote(request):
    fee = [FEE_NANO, 0] if request["currency"] == "USD" else [0, FEE_NANO]
    return {"max_tokens": request["max_tokens"], "reserved_nano": fee,
            "rates": [0, 0, 0], "context": {"fee_nano": fee}}


def settle(request):
    return {"cost_nano": request["context"]["fee_nano"], "settled_rates": None,
            "pricing_period": "unknown", "cost_basis": "custom_estimate"}
