# شاورمات · Shawermat

Flask ordering website for **Shawermat**, a shawarma restaurant in Dammam (حي الزهور).
Customers browse the menu, build a cart, and confirm via WhatsApp (cash on delivery /
pickup). The kitchen manages orders from an admin dashboard and prints 4×6 thermal
labels over Bluetooth.

## Features

- 📱 Menu + cart, order confirmation over WhatsApp
- 🚚 **Delivery** (الزهور / السلام) **or 🏪 in-store pickup** (no fee)
- 🎁 Loyalty: every **4** delivered orders → 5th delivery free · free delivery on carts ≥ 50 ريال
- 🤖 **شيفو (Chefo)** — Claude-powered chatbot that knows the menu and FAQ
- 🖨️ **Bluetooth thermal printing** (TSPL) straight from the admin tablet — see `static/printer_test.html`
- 📍 Per-order tracking pages protected by a random token
- 🔔 Admin dashboard: live new-order alerts, status updates, driver/customer WhatsApp buttons
- 📲 Installable PWA (service worker, offline fallback)

## Tech

- **Python 3.10 + Flask** — `app.py` is the whole backend
- **Anthropic API** (`claude-haiku-4-5`) for the chatbot
- Orders persist to `data/orders.json` (no database) with a file lock + atomic writes

## Local setup

```bash
python -m venv venv
# Windows:  venv\Scripts\activate
# macOS/Linux:  source venv/bin/activate

pip install -r requirements.txt

cp .env.example .env      # then edit .env (see below)

python app.py             # http://localhost:5000
```

## Environment variables

Configured in `.env` locally (git-ignored) and in the WSGI file in production.
Copy `.env.example` → `.env` and fill in:

| Variable | Required | Purpose |
|----------|----------|---------|
| `ADMIN_PASSWORD` | ✅ | Login for `/admin` (HTTP Basic auth). Admin is **locked** if unset. |
| `ANTHROPIC_API_KEY` | optional | Enables the شيفو chatbot. When empty, the bot shows a WhatsApp fallback. |
| `SUMMARY_EMAIL_PASS` | optional | Gmail App Password used by `daily_summary.py`. |

> ⚠️ Never commit `.env`. Never commit `data/orders.json` — it holds customer names,
> phones, addresses, and GPS coordinates. Both are already in `.gitignore`.

## Admin

- Dashboard: `/admin` (Basic auth — password = `ADMIN_PASSWORD`)
- Print a label: 🖨 button per order (Web Bluetooth → TSPL). Chrome on the tablet only.

## Deployment (PythonAnywhere)

1. Upload changed files (or `git pull` this repo on the server).
2. Set env vars (`ADMIN_PASSWORD`, `ANTHROPIC_API_KEY`) in the WSGI file.
3. Force a reload — the web-UI Reload button can silently fail:
   ```bash
   touch /var/www/www_shawermat_com_wsgi.py
   ```

## Project layout

```
app.py                  # routes, chatbot, order/pricing/loyalty logic
templates/              # index (menu), admin, track, print_tag
static/js/app.js        # cart, ordering, loyalty, chatbot UI
static/js/sw.js         # service worker (network-first)
static/printer_test.html# standalone Bluetooth printer diagnostic
data/orders.json        # order store (git-ignored)
daily_summary.py        # optional daily email summary
```
