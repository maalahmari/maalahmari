#!/usr/bin/env python3.10
"""
Shawermat — archive the pre-launch test orders so launch starts clean.

Every order currently in data/orders.json is junk from testing (تجربة / اختبار
/ ولاء تجربة ... ), placed before the real launch. This script NEVER deletes
anything — it copies the current store into a dated archive file under
data/archive/ and, only in a separate second step, resets data/orders.json to
an empty list so the first real customer order becomes order #1.

It is REVIEW-GATED and runs in two phases:

  Phase 1 — archive only (safe; does NOT touch orders.json):
      python3.10 archive_test_orders.py
      → writes data/archive/orders-archived-YYYY-MM-DD_HHMMSS.json
      → leaves data/orders.json exactly as it is

  Review that archive file (Files tab, or `cat` it), confirm it holds the
  test orders you expected, THEN:

  Phase 2 — empty the live store:
      python3.10 archive_test_orders.py --reset
      → verifies the newest archive still matches orders.json exactly (so no
        new order slipped in between the two steps), then resets orders.json
        to [] and keeps the archive untouched.

No web reload is needed — the app reads orders.json fresh on every request.
"""
import os
import sys
import json
import glob
from datetime import datetime

BASE_DIR     = os.path.dirname(os.path.abspath(__file__))
DATA_FILE    = os.path.join(BASE_DIR, "data", "orders.json")
ARCHIVE_DIR  = os.path.join(BASE_DIR, "data", "archive")


def load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            content = f.read().strip()
        return json.loads(content) if content else []
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def atomic_write(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def latest_archive():
    files = sorted(glob.glob(os.path.join(ARCHIVE_DIR, "orders-archived-*.json")))
    return files[-1] if files else None


def phase_archive(orders):
    print(f"Found {len(orders)} order(s) in the live store:")
    for o in orders:
        print(f"  #{o.get('id')}  {o.get('name', '?')}  {o.get('phone', '?')}  "
              f"[{o.get('status', '?')}]  {o.get('created_at', '?')}")

    os.makedirs(ARCHIVE_DIR, exist_ok=True)
    stamp   = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    archive = os.path.join(ARCHIVE_DIR, f"orders-archived-{stamp}.json")
    atomic_write(archive, orders)

    print(f"\nArchive written -> {archive}")
    print("orders.json was NOT modified.")
    print("Review the archive, then run again with --reset to empty the live store.")


def phase_reset(orders):
    archive = latest_archive()
    if not archive:
        print("No archive found. Run without --reset first to create one, then review it.")
        return
    if load_json(archive) != orders:
        print(f"SAFETY STOP: {os.path.basename(archive)} no longer matches the current "
              "orders.json — a new order may have arrived since you archived. Re-run "
              "without --reset to make a fresh archive, review it, then --reset again.")
        return

    atomic_write(DATA_FILE, [])
    print(f"Verified current orders.json against {os.path.basename(archive)}.")
    print(f"orders.json reset to []. The archived copy is kept at:\n  {archive}")
    print("The next real order will be #1.")


def main():
    orders = load_json(DATA_FILE)
    if "--reset" in sys.argv:
        phase_reset(orders)
        return
    if not orders:
        print("orders.json is already empty — nothing to archive.")
        return
    phase_archive(orders)


if __name__ == "__main__":
    main()
