"""Fiatsend payout starter (Python 3.9+, `pip install requests`).

Usage:
    export FIATSEND_API_KEY=fs_test_...
    python payout.py +233241234567 MTN 10.00
"""
import os
import re
import sys
import time

import requests

BASE = os.environ.get("FIATSEND_BASE_URL", "https://sandbox.fiatsend.com/v1")
KEY = os.environ["FIATSEND_API_KEY"]
RETRYABLE = {"RATE_LIMITED", "NETWORK_DOWN", "INSUFFICIENT_LIQUIDITY", "INTERNAL_ERROR"}


class FiatsendError(Exception):
    def __init__(self, status, code, message):
        super().__init__(f"{status} {code}: {message}")
        self.status, self.code = status, code


def call(method, path, **kw):
    r = requests.request(
        method, f"{BASE}{path}",
        headers={"Authorization": f"Bearer {KEY}"}, timeout=30, **kw,
    )
    body = r.json() if r.content else {}
    if not r.ok:
        err = body.get("error", body)
        raise FiatsendError(r.status_code, err.get("code"), err.get("message"))
    return body


def normalise_gh_phone(phone: str) -> str:
    digits = re.sub(r"\D", "", phone)
    if digits.startswith("233"):
        digits = digits[3:]
    elif digits.startswith("0"):
        digits = digits[1:]
    if len(digits) != 9:
        raise ValueError(f"Not a Ghana mobile number: {phone}")
    return "+233" + digits


def send_payout(phone, network, amount, reference_id, currency="USDC"):
    """reference_id must come from your own stored record so retries reuse it."""
    payload = {
        "amount": amount, "currency": currency,
        "recipient_phone": normalise_gh_phone(phone),
        "mobile_network": network, "reference_id": reference_id,
    }
    for attempt in range(4):
        try:
            # Re-posting the same reference_id returns the existing withdrawal,
            # so retrying after a timeout can never create a second payout.
            return call("POST", "/withdrawals", json=payload)["data"]
        except requests.Timeout:
            if attempt == 3:
                raise
        except FiatsendError as e:
            if e.code not in RETRYABLE or attempt == 3:
                raise
        time.sleep(2 ** attempt)


if __name__ == "__main__":
    phone, network, amount = sys.argv[1:4]
    nets = {n["network_id"]: n for n in call("GET", "/supported-networks")["data"]}
    if nets.get(network, {}).get("status") != "operational":
        sys.exit(f"{network} is not operational right now")
    quote = call("GET", "/rates", params={"from_currency": "USDC", "to_currency": "GHS", "amount": amount})["data"]
    print(f"Quote: {amount} USDC -> GHS {quote['total_ghs']} (rate {quote['rate']}, valid until {quote['valid_until']})")
    w = send_payout(phone, network, amount, reference_id=f"demo_{int(time.time())}")
    print(f"Created {w['withdrawal_id']} — status {w['status']}")
