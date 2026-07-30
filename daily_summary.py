#!/usr/bin/env python3.10
"""
Shawermat — daily order summary emailer.

Run automatically via a PythonAnywhere Scheduled Task at 23:00 UTC,
which is 02:00 Saudi time (UTC+3) — i.e. one hour after closing.

It reads data/orders.json, summarizes the night's orders, and emails
the summary to the owner. Credentials are read from environment
variables so no secrets live in the code:

    SUMMARY_EMAIL_USER  Gmail address that sends   (default below)
    SUMMARY_EMAIL_PASS  Gmail *App Password*       (required to send)
    SUMMARY_EMAIL_TO    where the summary is sent  (default below)

Scheduled-task command (set the password inline so it stays out of code):
    SUMMARY_EMAIL_PASS='your-app-password' python3.10 /home/moshabab/shawermat/daily_summary.py
"""
import os
import json
import smtplib
from datetime import datetime, timedelta
from email.mime.text import MIMEText
from email.header import Header
from collections import Counter

BASE_DIR  = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(BASE_DIR, "data", "orders.json")

EMAIL_USER = os.environ.get("SUMMARY_EMAIL_USER", "maalahmari@gmail.com")
EMAIL_PASS = os.environ.get("SUMMARY_EMAIL_PASS", "")            # Gmail App Password
EMAIL_TO   = os.environ.get("SUMMARY_EMAIL_TO",   "maalahmari@gmail.com")

# Business night runs ~3 PM .. 1 AM, so a 12-hour lookback from the 2 AM
# run captures the whole shift (orders from ~2 PM onward).
WINDOW_HOURS = 12


def load_orders():
    try:
        with open(DATA_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def build_summary():
    now    = datetime.now()
    cutoff = now - timedelta(hours=WINDOW_HOURS)
    # Label the report with the date the shift started (subtract a few hours
    # so a 2 AM run is attributed to the previous calendar day).
    business_date = (now - timedelta(hours=4)).strftime("%Y-%m-%d")

    nights = []
    for o in load_orders():
        try:
            placed = datetime.strptime(o.get("created_at", ""), "%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
        if placed >= cutoff:
            nights.append(o)

    delivered   = [o for o in nights if o.get("status") == "delivered"]
    cancelled   = [o for o in nights if o.get("status") == "cancelled"]
    draft       = [o for o in nights if o.get("status") == "draft"]
    in_progress = [o for o in nights if o.get("status") in
                   ("pending", "confirmed", "preparing", "delivering")]

    revenue = sum(int(o.get("total", 0)) for o in delivered)

    items = Counter()
    for o in nights:
        for it in o.get("items", []):
            items[it.get("name", "?")] += int(it.get("qty", 0))
    top = items.most_common(1)
    top_line = f"{top[0][0]} ({top[0][1]})" if top else "—"

    lines = [
        f"📊 ملخص شاورمات — ليلة {business_date}",
        "———————————",
        f"📦 إجمالي الطلبات: {len(nights)}",
        f"✅ مكتملة (وصلت): {len(delivered)} — {revenue} ريال",
        f"🔄 قيد التنفيذ: {len(in_progress)}",
        f"📲 لم تُؤكد (واتساب): {len(draft)}",
        f"✕ ملغية: {len(cancelled)}",
        "———————————",
        f"🏆 أكثر صنف مطلوب: {top_line}",
        f"💰 مبيعات الليلة: {revenue} ريال",
    ]
    return business_date, len(nights), "\n".join(lines)


def main():
    business_date, count, body = build_summary()

    if not EMAIL_PASS:
        print("SUMMARY_EMAIL_PASS not set — printing summary instead:\n")
        print(body)
        return

    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = Header(f"ملخص شاورمات — {business_date} ({count} طلب)", "utf-8")
    msg["From"]    = EMAIL_USER
    msg["To"]      = EMAIL_TO

    with smtplib.SMTP("smtp.gmail.com", 587) as server:
        server.starttls()
        server.login(EMAIL_USER, EMAIL_PASS)
        server.sendmail(EMAIL_USER, [EMAIL_TO], msg.as_string())
    print(f"Sent summary email to {EMAIL_TO}")


if __name__ == "__main__":
    main()
