#!/usr/bin/env python3
"""
Shawermat — order simulator.
Sends a small batch of realistic test orders to the live site.
Usage:
    python simulate_orders.py                  # targets https://www.shawermat.com
    python simulate_orders.py http://localhost:5000
"""
import json
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime

BASE_URL = (sys.argv[1].rstrip("/") if len(sys.argv) > 1
            else "https://www.shawermat.com")

# 4 realistic test orders (different phones to bypass duplicate guard)
ORDERS = [
    {
        "name": "محمد العتيبي",
        "phone": "0501111001",
        "neighborhood": "الزهور",
        "items": [
            {"name": "شاورما ثوم",    "qty": 2, "price": 7},
            {"name": "بطاطس كبير",    "qty": 1, "price": 10},
            {"name": "بيبسي",         "qty": 2, "price": 4},
        ],
        "total": 32,
        "note": "بدون بصل",
    },
    {
        "name": "أحمد الشمري",
        "phone": "0502222002",
        "neighborhood": "السلام",
        "items": [
            {"name": "وجبة جامبو + بيبسي + بطاطس", "qty": 1, "price": 19},
            {"name": "علبة ثوم",                    "qty": 1, "price": 2},
        ],
        "total": 26,
        "note": "",
    },
    {
        "name": "سارة القحطاني",
        "phone": "0503333003",
        "neighborhood": "الزهور",
        "items": [
            {"name": "شاورما عربي",   "qty": 1, "price": 20},
            {"name": "بطاطس صغير",   "qty": 1, "price": 5},
            {"name": "سفن أب",        "qty": 1, "price": 4},
        ],
        "total": 34,
        "note": "صوص حار زيادة",
    },
    {
        "name": "خالد الدوسري",
        "phone": "0504444004",
        "neighborhood": "الزهور",
        "items": [
            {"name": "وجبة شاورما عربي دبل + بيبسي + بطاطس", "qty": 1, "price": 34},
            {"name": "بيبسي",                                  "qty": 1, "price": 4},
        ],
        "total": 43,
        "note": "",
    },
]


def post_order(order):
    url = f"{BASE_URL}/api/order"
    body = json.dumps(order).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    print(f"\n{'='*50}")
    print(f"  شاورمات — محاكاة طلبات ({datetime.now().strftime('%H:%M:%S')})")
    print(f"  الهدف: {BASE_URL}")
    print(f"{'='*50}\n")

    success = 0
    for i, order in enumerate(ORDERS, 1):
        try:
            result = post_order(order)
            order_id = result.get("order_id", "?")
            dup = " (مكرر — نفس الطلب موجود)" if result.get("duplicate") else ""
            print(f"  ✅ طلب #{i} — {order['name']} — رقم #{order_id}{dup}")
            success += 1
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="ignore")
            print(f"  ❌ طلب #{i} — {order['name']} — خطأ {e.code}: {body}")
        except Exception as e:
            print(f"  ❌ طلب #{i} — {order['name']} — {e}")

        if i < len(ORDERS):
            time.sleep(1)  # second between orders

    print(f"\n{'='*50}")
    print(f"  النتيجة: {success}/{len(ORDERS)} طلب أُرسل بنجاح")
    print(f"  افتح لوحة الإدارة: {BASE_URL}/admin")
    print(f"{'='*50}\n")


if __name__ == "__main__":
    main()
