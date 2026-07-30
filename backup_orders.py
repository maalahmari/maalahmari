#!/usr/bin/env python3.10
"""
Shawermat — daily backup of the order store.

Copies data/orders.json to data/backups/orders-YYYY-MM-DD.json once a day,
then prunes so only the most recent 30 daily backups are kept.

Run automatically via a PythonAnywhere Scheduled Task (daily). Since the
business night runs ~3 PM .. 1 AM, schedule it in the morning (e.g. 05:00 UTC
= 08:00 Saudi) so the copy captures the whole previous shift.

Scheduled-task command:
    python3.10 /home/moshabab/shawermat/backup_orders.py

The copy is atomic (write to a temp file, then os.replace) so a backup is
never left half-written even if orders.json is being saved at the same moment.
"""
import os
import shutil
from datetime import datetime

BASE_DIR    = os.path.dirname(os.path.abspath(__file__))
DATA_FILE   = os.path.join(BASE_DIR, "data", "orders.json")
BACKUP_DIR  = os.path.join(BASE_DIR, "data", "backups")

KEEP = 30  # number of daily backups to retain


def make_backup():
    if not os.path.exists(DATA_FILE):
        print(f"Nothing to back up — {DATA_FILE} does not exist yet.")
        return None

    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp  = datetime.now().strftime("%Y-%m-%d")
    dest   = os.path.join(BACKUP_DIR, f"orders-{stamp}.json")
    tmp    = dest + ".tmp"

    # Copy to a temp name first, then atomically swap into place so a backup
    # is never observed half-written. Overwrites today's copy if it re-runs.
    shutil.copy2(DATA_FILE, tmp)
    os.replace(tmp, dest)
    print(f"Backed up orders.json -> {dest}")
    return dest


def prune_old():
    if not os.path.isdir(BACKUP_DIR):
        return
    backups = sorted(
        f for f in os.listdir(BACKUP_DIR)
        if f.startswith("orders-") and f.endswith(".json")
    )
    # Names sort chronologically (YYYY-MM-DD), so the oldest are at the front.
    for stale in backups[:-KEEP] if len(backups) > KEEP else []:
        path = os.path.join(BACKUP_DIR, stale)
        try:
            os.remove(path)
            print(f"Pruned old backup {stale}")
        except OSError as e:
            print(f"Could not remove {stale}: {e}")


def main():
    make_backup()
    prune_old()


if __name__ == "__main__":
    main()
