from flask import Flask, render_template, request, jsonify, send_from_directory, Response
from functools import wraps
from collections import deque
import json
import os
import re
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone
import anthropic

# ── Time ────────────────────────────────────────────────────────────────────
# The host (PythonAnywhere) runs on UTC, so a bare datetime.now() stamped every
# order 3 hours behind the shop's actual clock. Saudi Arabia is UTC+3 all year
# with no DST, so a fixed offset is exact and needs no tzdata package.
# Returns a NAIVE datetime holding Saudi wall-clock time: timestamps are stored
# as plain strings and parsed back naive, so an aware value here would raise
# "can't subtract offset-naive and offset-aware datetimes" on the duplicate check.
SAUDI_UTC_OFFSET = timedelta(hours=3)


def saudi_now():
    """Current Saudi wall-clock time, timezone-naive."""
    return datetime.now(timezone.utc).replace(tzinfo=None) + SAUDI_UTC_OFFSET

# Load .env for local development. Production sets env vars in the WSGI file,
# so python-dotenv is optional there — don't crash if it isn't installed.
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

app = Flask(__name__)


# Static assets are cached hard by browsers, so a deploy would otherwise leave
# returning customers running the previous build indefinitely. Stamping the
# file's mtime into the URL busts that cache on change, and only on change.
@app.template_global()
def static_v(filename):
    try:
        return int(os.path.getmtime(os.path.join(app.static_folder, filename)))
    except OSError:
        return 0


ANTHROPIC_API_KEY = os.environ.get('ANTHROPIC_API_KEY', '')

# Admin dashboard password — set ADMIN_PASSWORD in .env (local) or the WSGI file
# (production). No hardcoded default: if it's unset the admin panel stays locked.
ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD')


def _admin_ok():
    auth = request.authorization
    # Require a configured password: if ADMIN_PASSWORD is unset, admin is locked.
    return bool(ADMIN_PASSWORD) and auth is not None and auth.password == ADMIN_PASSWORD


def _admin_challenge():
    return Response(
        "🔒 تسجيل الدخول مطلوب للوحة الإدارة", 401,
        {"WWW-Authenticate": 'Basic realm="Shawermat Admin"'},
    )


def require_admin(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not _admin_ok():
            return _admin_challenge()
        return f(*args, **kwargs)
    return wrapper

CHAT_SYSTEM = """أنت "شيفو" — المساعد الرقمي الذكي لمطعم شاورمات بالدمام (روبوت ودود بقبعة شيف 🤖).

شخصيتك:
- ودود ومرح بلهجة سعودية خليجية فقط: "أهلين"، "أبشر"، "تأمر"، "وش تشتهي"
- ممنوع تماماً أي كلمات غير سعودية مثل "شنو" أو "مش" أو "شلونك" — استخدم بدالها "وش" و"مو" و"كيف حالك"
- صادق إنك مساعد آلي، وتفتخر إنك تعرف المنيو عن ظهر قلب
- مساعد سريع وعملي — تساعد العميل يختار الأنسب لذوقه وميزانيته
- مختصر — لا تتجاوز 3 جمل، دائماً بالعربية العامية السعودية
- اكتب بنص عادي فقط، بدون أي رموز تنسيق (بدون نجوم ** وبدون رمز #)

معلومات المطعم:
- أوقات العمل: 3 عصراً حتى 2 صباحاً يومياً (نفس الدوام للفرعين)
- عندنا فرعان: فرع حي الزهور، وفرع أحد
- التوصيل: حي الزهور وحي السلام (من فرع الزهور)، وحي أحد وحي بدر (من فرع أحد) — التوصيل مجاني حالياً لكل الأحياء (عرض لفترة محدودة، وبعده يرجع 5 ريال)
- العميل ما يحتاج يختار الفرع: يختار حيّه عند إتمام الطلب والطلب يروح للفرع الأقرب تلقائياً. أما الاستلام من المحل فيختار الفرع اللي يبي يستلم منه
- عرض التوصيل المجاني 🎉: التوصيل مجاني لكل الطلبات بدون حد أدنى (عرض لفترة محدودة)
- الحد الأدنى للطلب: 15 ريال
- الدفع: كاش عند الاستلام فقط
- واتساب: 966533647130
- الولاء: بعد كل 4 طلبات، الطلب الخامس توصيله مجاني 🎁
- الطلب عبر الموقع: توصيل، أو استلام من المحل 🏪 بدون أي رسوم (يختار العميل «استلام من المحل» في السلة) — لا يوجد جلوس في الصالة

المنيو (الأسعار بالريال — اذكرها دايماً بصيغة «X ريال»):
شاورما ساندويش (مفرد، بدون كومبو): مايونيز/ثوم/حراق/حمص/جبن=7 | مشكل=8 | صاروخ=13 | جامبو=13 | عربي مفرد=20 | عربي دبل=32 | صحن صغير=18 | صحن كبير=25
الوجبة = كومبو ثابت (شاورما + بطاطس + بيبسي)، وسعرها يتغيّر حسب عدد الشاورما داخلها فقط (البطاطس والبيبسي ثابتة):
وجبة شاورما: شاورما واحدة=14 | شاورمتين=20 | ثلاث شاورما=26
وجبات أخرى: وجبة صاروخ=19 | وجبة جامبو=19 | وجبة عربي مفرد=22 | وجبة عربي دبل=34 | وجبة عائلية 10 شاورما=85 | وجبة عائلية 15 شاورما=118 | وجبة بروستد 4قطع=20 | وجبة بروستد 8قطع=36
جانبيات: بطاطس صغير=5 | بطاطس كبير=10 | بروستد 4قطع=17 | بروستد 8قطع=32 (البروستد بنكهة عادي أو سبايسي، نفس السعر) | ثوم=2 | سبايسي=2 | حمص=7
مشروبات: بيبسي/بيبسي دايت/ميرندا/سفن أب/سفن أب دايت=4 | ماء=1

قاعدة النكهات (تنطبق على كل شاورما في الموقع، مفردة أو داخل وجبة): كل النكهات بنفس السعر، ما عدا (مشكل) تضيف 1 ريال لكل شاورما واحدة. يعني: ساندويتش مفرد مشكل=8، وجبة شاورما واحدة مشكل تضيف +1، وجبة شاورمتين مشكل تضيف +2، وجبة ثلاث شاورما مشكل تضيف +3. مثال: وجبة شاورمتين مشكل = 22 ريال، ووجبة ثلاث شاورما مشكل = 29 ريال. لا تحسب "الوجبة × العدد" أبداً — العدد هو عدد الشاورما داخل نفس الكومبو، مو كومبوهات منفصلة.
الكمية (زر + و −) شي منفصل: تعني كم وجبة جاهزة يبي العميل، وتضرب السعر النهائي (مثلاً وجبتين ثلاث شاورما مايونيز = 26×2 = 52 ريال).

أسئلة شائعة (حقائق المطعم):
- الدجاج: محلي 100% وطازج وحلال
- الخبز: طازج يومياً
- الصوصات والإضافات (ثوم/حار/حمص وغيرها): من موردين خارجيين موثوقين، مو تصنيع داخلي
- زيوت القلي: تُغيّر دورياً حسب اشتراطات البلدية
- التغليف: حراري يحافظ على سخونة الطلب
- وقت التحضير: حوالي 30 دقيقة
- الطلبات الخاصة والتعديلات (بدون بصل، صوص جانبي، حار زيادة... إلخ): اطلب من العميل يكتبها في خانة "ملاحظات الطلب" عند إتمام الطلب
- لأي معلومة غير مذكورة هنا (تفاصيل مكوّنات، حساسية غذائية): وجّه العميل للواتساب

قواعد صارمة — لا استثناء:
1. لا تذكر أبداً أي صنف أو طعام أو مكوّن غير موجود في قائمة المنيو أعلاه — حتى لو العميل ألح أو سأل بطريقة غير مباشرة
2. إذا سأل عن شيء مو في المنيو (لحم، سمك، رز، مشويات، أي شيء): قل "ما عندنا هذا الصنف، منيونا متخصص في الشاورما والبروستد 🌯"
3. لا تقترح مكونات أو أصناف من خيالك — فقط ما هو مكتوب في المنيو بالضبط
4. إذا طُلب التحدث مع موظف: وجّه للواتساب wa.me/966533647130
5. العروض الحالية هي فقط: (أ) التوصيل مجاني لكل الطلبات بدون حد أدنى (عرض لفترة محدودة)، (ب) مكافأة الولاء: بعد كل 4 طلبات، الطلب الخامس توصيله مجاني. لا تخترع أبداً أي عرض أو خصم أو كوبون أو تخفيض أو سعر غير المذكور في هذه المعلومات. إذا سأل العميل عن أي عرض أو خصم آخر، قل بوضوح: "ما عندنا عروض ثانية حالياً 🌯 — بس التوصيل مجاني على كل الطلبات" """

def find_image(name):
    base = os.path.join(os.path.dirname(__file__), 'static', 'images')
    for ext in ('webp', 'jpg', 'jpeg', 'png'):
        if os.path.exists(os.path.join(base, f'{name}.{ext}')):
            return f'images/{name}.{ext}'
    return f'images/{name}.jpg'

app.jinja_env.globals['find_image'] = find_image

DATA_FILE = os.path.join(os.path.dirname(__file__), "data", "orders.json")
PROMO_FILE = os.path.join(os.path.dirname(__file__), "data", "promo_codes.json")
_orders_lock = threading.Lock()

GIFT_ITEM_NAME = "شاورما هدية 🎁"  # free first-order item granted by a valid promo code

LOYALTY_REWARD = 4  # بعد كل 4 طلبات مكتملة → الطلب التالي (الخامس) توصيله مجاني

# ── PROMO: free delivery for everyone, 2026-08-04 → 2026-08-18 ──────────────
# Was 50. Set to 0 so every order qualifies. To END the promo, restore 50 here
# AND in static/js/app.js (FREE_DELIVERY_MIN) — the two must always match, or
# the cart shows a fee the server does not charge (or vice versa).
FREE_DELIVERY_MIN = 0   # items subtotal >= this (SAR) → delivery is free

ADMIN_RECENT_LIMIT = 50  # dashboard shows only the most recent N orders (poll stays light)

# ── Branches ────────────────────────────────────────────────────────────────
# One site, two branches. The customer never picks a branch for delivery —
# their neighborhood determines it (each branch serves its own hoods, and the
# two are ~8 km apart so the delivery zones don't overlap). Only pickup needs
# an explicit branch choice, since there's no hood to infer it from.
# To add a hood later: add it to that branch's "hoods" — nothing else changes.
DEFAULT_BRANCH = "zuhour"

BRANCHES = {
    "zuhour": {
        "id": "zuhour",
        "name": "فرع حي الزهور",
        "short": "الزهور",
        "whatsapp": "966533647130",   # orders for this branch go here
        "display_phone": "0533647130",
        "lat": 26.45517216793601,
        "lng": 50.096428124077356,
        "radius_km": 2.2,
        "hoods": {"الزهور": 5, "السلام": 5},
    },
    "uhud": {
        "id": "uhud",
        "name": "شاورمات فرع أحد",
        "short": "أحد",
        "whatsapp": "966542320488",
        "display_phone": "0542320488",
        "lat": 26.411495013143494,
        "lng": 50.03321196545751,
        "radius_km": 2.2,
        "hoods": {"أحد": 5, "بدر": 5},
    },
}

# Derived lookups — the pricing code below keeps using NEIGHBORHOOD_FEES
# unchanged; it just now covers every branch's hoods.
NEIGHBORHOOD_FEES = {
    hood: fee
    for br in BRANCHES.values()
    for hood, fee in br["hoods"].items()
}
HOOD_TO_BRANCH = {
    hood: br["id"]
    for br in BRANCHES.values()
    for hood in br["hoods"]
}


def _resolve_branch(hood, requested=""):
    """Which branch fulfils this order.

    Delivery: derived from the neighborhood server-side (never trust the
    client). Pickup: no hood to infer from, so honour the customer's explicit
    choice, validated against the known branches.
    """
    if hood:
        return HOOD_TO_BRANCH.get(hood, DEFAULT_BRANCH)
    if requested in BRANCHES:
        return requested
    return DEFAULT_BRANCH


def _public_branches():
    """Branch config safe to expose to the client (no internal-only fields)."""
    return {
        bid: {
            "id": br["id"],
            "name": br["name"],
            "short": br["short"],
            "whatsapp": br["whatsapp"],
            "display_phone": br["display_phone"],
            "lat": br["lat"],
            "lng": br["lng"],
            "radius_km": br["radius_km"],
            "hoods": br["hoods"],
        }
        for bid, br in BRANCHES.items()
    }

MENU = {
    "shawarma": [
        {"id": 1,  "name": "شاورما مايونيز",  "name_en": "Shawarma Mayo",          "price": 7,  "description": "شاورما دجاج بصوص المايونيز",    "image": "shawarma.jpg"},
        {"id": 2,  "name": "شاورما ثوم",       "name_en": "Shawarma Garlic",        "price": 7,  "description": "شاورما دجاج بصوص الثوم",         "image": "shawarma.jpg"},
        {"id": 3,  "name": "شاورما حراق",      "name_en": "Shawarma Spicy",         "price": 7,  "description": "شاورما دجاج بالصوص الحار",       "image": "shawarma.jpg"},
        {"id": 4,  "name": "شاورما حمص",       "name_en": "Shawarma Hummus",        "price": 7,  "description": "شاورما دجاج بصوص الحمص",         "image": "shawarma.jpg"},
        {"id": 5,  "name": "شاورما جبن",       "name_en": "Shawarma Cheese",        "price": 7,  "description": "شاورما دجاج بالجبن",             "image": "shawarma.jpg"},
        {"id": 6,  "name": "شاورما مشكل",      "name_en": "Shawarma Mixed",         "price": 8,  "description": "شاورما دجاج بصوص مشكل",          "image": "shawarma.jpg"},
        {"id": 8,  "name": "شاورما جامبو",     "name_en": "Shawarma Jumbo",         "price": 13, "description": "شاورما دجاج جامبو كبير الحجم",   "image": "jumbo.jpg"},
        {"id": 9,  "name": "صاروخ شاورما",     "name_en": "Shawarma Rocket",        "price": 13, "description": "شاورما دجاج على شكل صاروخ",      "image": "rocket.jpg"},
        {"id": 10, "name": "شاورما عربي",      "name_en": "Shawarma Arabic",        "price": 20, "description": "شاورما عربية بالخبز العربي",     "image": "arabic.jpg"},
        {"id": 11, "name": "شاورما عربي دبل",  "name_en": "Shawarma Arabic Double", "price": 32, "description": "شاورما عربية دبل بالخبز العربي", "image": "arabic.jpg"},
        {"id": 12, "name": "صحن شاورما",       "name_en": "Shawarma Plate",         "price": 18, "description": "صحن شاورما (صغير: 18 ريال | كبير: 25 ريال)", "image": "plate.jpg"},
    ],
    "meals": [
        {"id": 13, "name": "وجبة سندويتش + بيبسي + بطاطس",        "name_en": "1 Sandwich Meal",     "price": 14,  "description": "سندويتش شاورما + بطاطس + بيبسي",      "image": "pepsi_meal.jpg"},
        {"id": 14, "name": "وجبة صاروخ + بيبسي + بطاطس",          "name_en": "Rocket Meal",         "price": 19,  "description": "صاروخ شاورما + بطاطس + بيبسي",        "image": "pepsi_meal.jpg"},
        {"id": 15, "name": "وجبة جامبو + بيبسي + بطاطس",          "name_en": "Jumbo Meal",          "price": 19,  "description": "جامبو شاورما + بطاطس + بيبسي",        "image": "pepsi_meal.jpg"},
        {"id": 16, "name": "وجبة 2 سندويتش + بيبسي + بطاطس",      "name_en": "2 Sandwiches Meal",   "price": 20,  "description": "سندويتشان شاورما + بطاطس + بيبسي",    "image": "meal3.jpg"},
        {"id": 17, "name": "وجبة عائلية 2 سندويتش + بيبسي عائلي", "name_en": "Family Meal (2 pcs)", "price": 59,  "description": "2 سندويتش + 2 بطاطس + بيبسي عائلي",  "image": "meal_family.jpg"},
        {"id": 18, "name": "وجبة عائلية 3 سندويتش + بيبسي عائلي", "name_en": "Family Meal (3 pcs)", "price": 84,  "description": "3 سندويتش + 3 بطاطس + بيبسي عائلي",  "image": "meal_family.jpg"},
        {"id": 19, "name": "وجبة جمعات 5 سندويتش + بيبسي عائلي",  "name_en": "Group Meal (5 pcs)",  "price": 115, "description": "5 سندويتش + 3 بطاطس + بيبسي عائلي",  "image": "pepsi_diet.jpg"},
        {"id": 20, "name": "وجبة شاورما عربي مفرد + بيبسي + بطاطس",  "name_en": "Arabic Meal Single", "price": 22,  "description": "شاورما عربي + بطاطس + بيبسي",        "image": "arabic_meal.jpg"},
        {"id": 21, "name": "وجبة شاورما عربي دبل + بيبسي + بطاطس",  "name_en": "Arabic Meal Double", "price": 34,  "description": "شاورما عربي دبل + بطاطس + بيبسي",   "image": "arabic_meal.jpg"},
    ],
    "sides": [
        {"id": 22, "name": "بطاطس صغير",   "name_en": "Fries Small",   "price": 5,  "description": "بطاطس مقلية",      "image": "fries.jpg"},
        {"id": 23, "name": "بطاطس كبير",   "name_en": "Fries Large",   "price": 10, "description": "بطاطس مقلية كبير", "image": "fries.jpg"},
        {"id": 24, "name": "بروستد",        "name_en": "Broasted",      "price": 17, "description": "دجاج بروستد",      "image": "broasted.jpg"},
        {"id": 25, "name": "علبة ثوم",      "name_en": "Garlic Sauce",  "price": 2,  "description": "صوص ثوم"},
        {"id": 26, "name": "علبة حار",      "name_en": "Spicy Sauce",   "price": 2,  "description": "صوص حار"},
        {"id": 27, "name": "مايونيز",       "name_en": "Mayonnaise",    "price": 2,  "description": "صوص مايونيز"},
        {"id": 28, "name": "علبة حمص",      "name_en": "Hummus",        "price": 7,  "description": "حمص"},
    ],
    "drinks": [
        {"id": 29, "name": "بيبسي",        "name_en": "Pepsi",      "price": 4, "description": "بيبسي بارد",   "image": "pepsi.jpg"},
        {"id": 30, "name": "بيبسي زيرو",   "name_en": "Pepsi Zero", "price": 4, "description": "بيبسي زيرو",   "image": "pepsi.jpg"},
        {"id": 31, "name": "ميرندا",       "name_en": "Mirinda",    "price": 4, "description": "ميرندا",       "image": "mirinda.jpg"},
        {"id": 32, "name": "سفن أب",       "name_en": "7UP",        "price": 4, "description": "سفن أب",       "image": "7up.jpg"},
        {"id": 33, "name": "سفن أب زيرو",  "name_en": "7UP Zero",   "price": 4, "description": "سفن أب زيرو",  "image": "7up.jpg"},
        {"id": 34, "name": "ماء",           "name_en": "Water",      "price": 1, "description": "ماء معدني"},
    ],
}

CATEGORY_LABELS = {
    "shawarma": "شاورما",
    "meals":    "وجبات",
    "sides":    "جانبيات",
    "drinks":   "مشروبات",
}


def load_orders():
    if not os.path.exists(DATA_FILE):
        return []
    try:
        with open(DATA_FILE, encoding="utf-8") as f:
            content = f.read().strip()
        if not content:
            return []
        return json.loads(content)
    except (json.JSONDecodeError, IOError):
        return []


def save_orders(orders):
    tmp = DATA_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(orders, f, indent=2, ensure_ascii=False)
    os.replace(tmp, DATA_FILE)


def load_promo_codes():
    """code -> grocery name. Kept in its own file so new stores/codes can be
    added by editing JSON, without touching app.py."""
    if not os.path.exists(PROMO_FILE):
        return {}
    try:
        with open(PROMO_FILE, encoding="utf-8") as f:
            content = f.read().strip()
        if not content:
            return {}
        raw = json.loads(content)
        return {str(k).strip().upper(): v for k, v in raw.items()}
    except (json.JSONDecodeError, IOError, AttributeError):
        return {}


def normalize_saudi_phone(raw):
    """Same normalization the client applies — 05XXXXXXXX, or None if invalid."""
    digits = re.sub(r"\D", "", raw or "")
    if re.fullmatch(r"9665\d{8}", digits):
        return "0" + digits[3:]
    if re.fullmatch(r"05\d{8}", digits):
        return digits
    if re.fullmatch(r"5\d{8}", digits):
        return "0" + digits
    return None


def _has_prior_order(phone_norm, orders):
    """Any non-cancelled order already on file for this phone number?"""
    for o in orders:
        if o.get("status") == "cancelled":
            continue
        existing = normalize_saudi_phone(o.get("phone", "")) or o.get("phone", "")
        if existing == phone_norm:
            return True
    return False


def _validate_promo(code_raw, phone_raw, orders):
    """Returns (ok, message, grocery_name). Case/space-insensitive on the code."""
    code = (code_raw or "").strip().upper()
    if not code:
        return False, "", None
    promo_map = load_promo_codes()
    if code not in promo_map:
        return False, "الكود غير صحيح", None
    phone_norm = normalize_saudi_phone(phone_raw) or (phone_raw or "").strip()
    if _has_prior_order(phone_norm, orders):
        return False, "العرض للطلب الأول فقط — نقاط الولاء تنتظرك 😉", None
    return True, "تم تطبيق الكود 🎉", promo_map[code]


def _promo_stats():
    """Order count per promo code — what grocery-store rewards are based on."""
    orders = load_orders()
    counts = {}
    for o in orders:
        code = (o.get("promo_code") or "").strip().upper()
        if not code or o.get("status") == "cancelled":
            continue
        counts[code] = counts.get(code, 0) + 1
    promo_map = load_promo_codes()
    stats = [
        {"code": code, "grocery": grocery, "count": counts.get(code, 0)}
        for code, grocery in promo_map.items()
    ]
    for code, cnt in counts.items():
        if code not in promo_map:
            stats.append({"code": code, "grocery": "(غير مسجّل في القائمة)", "count": cnt})
    return stats


@app.route("/api/promo/check", methods=["POST"])
def check_promo():
    data = request.get_json() or {}
    orders = load_orders()
    ok, message, grocery = _validate_promo(data.get("code", ""), data.get("phone", ""), orders)
    return jsonify({"valid": ok, "message": message, "grocery": grocery})


@app.route("/")
def index():
    return render_template(
        "index.html",
        menu=MENU,
        labels=CATEGORY_LABELS,
        neighborhood_fees=NEIGHBORHOOD_FEES,
        branches=_public_branches(),
        hood_to_branch=HOOD_TO_BRANCH,
        default_branch=DEFAULT_BRANCH,
    )


# Service worker must be served from the root path so its scope covers the whole site
@app.route("/sw.js")
def service_worker():
    return send_from_directory(
        os.path.join(os.path.dirname(__file__), "static", "js"),
        "sw.js",
        mimetype="application/javascript",
    )


# ── Chatbot rate limiting ──────────────────────────────────────────────
# Each call to /api/chat costs an Anthropic API request, so cap how many a
# single visitor can fire in a rolling window. In-memory per-client counters
# are enough here (single small site); they reset on reload, which is fine.
CHAT_RATE_MAX = 20        # messages allowed...
CHAT_RATE_WINDOW = 300    # ...per this many seconds (5 minutes), per client

_chat_hits = {}                    # client key -> deque[timestamps]
_chat_rate_lock = threading.Lock()


def _client_key():
    # Behind the PythonAnywhere proxy the real client IP is in X-Forwarded-For
    # (first hop); fall back to remote_addr for local runs.
    fwd = request.headers.get("X-Forwarded-For", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.remote_addr or "unknown"


def _chat_rate_limited():
    """Record a hit for this client and report whether they're over the cap."""
    now = time.monotonic()
    key = _client_key()
    with _chat_rate_lock:
        hits = _chat_hits.get(key)
        if hits is None:
            hits = deque()
            _chat_hits[key] = hits
        # Drop timestamps that fell out of the window.
        while hits and now - hits[0] > CHAT_RATE_WINDOW:
            hits.popleft()
        if len(hits) >= CHAT_RATE_MAX:
            return True
        hits.append(now)
        # Opportunistic cleanup so idle clients don't accumulate forever.
        if len(_chat_hits) > 1000:
            for k in [k for k, v in _chat_hits.items() if not v or now - v[-1] > CHAT_RATE_WINDOW]:
                _chat_hits.pop(k, None)
        return False


@app.route("/api/chat", methods=["POST"])
def chat_api():
    data = request.get_json()
    if not data:
        return jsonify({"error": "invalid request"}), 400
    message = (data.get("message") or "").strip()
    history = data.get("history") or []
    if not message:
        return jsonify({"error": "empty message"}), 400
    if _chat_rate_limited():
        # Frontend shows data.reply regardless of status; 429 is still correct.
        return jsonify({"reply": "بعتذر منك 🙏 كثرت الأسئلة بسرعة — أعطني دقيقتين بسيطة وأعاود مساعدتك. وإذا طلبك مستعجل كلمنا واتساب 📱"}), 429
    if not ANTHROPIC_API_KEY:
        return jsonify({"reply": "الشاتبوت غير مفعّل حالياً. تواصل معنا على واتساب 📱"}), 200
    try:
        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        messages = []
        for h in history[-6:]:
            if h.get("role") in ("user", "assistant") and h.get("content"):
                messages.append({"role": h["role"], "content": h["content"]})
        messages.append({"role": "user", "content": message})
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=300,
            temperature=0,
            system=CHAT_SYSTEM,
            messages=messages,
        )
        return jsonify({"reply": response.content[0].text})
    except Exception:
        return jsonify({"reply": "عذراً، حدث خطأ. تواصل معنا على واتساب 📱"}), 200


@app.route("/api/order", methods=["POST"])
def place_order():
    data = request.get_json()
    if not data:
        return jsonify({"error": "Invalid request"}), 400

    for field in ["name", "phone", "items"]:
        if not data.get(field):
            return jsonify({"error": f"Missing field: {field}"}), 400
    # Address is optional — location is shared via WhatsApp after confirmation

    if not data["items"]:
        return jsonify({"error": "Cart is empty"}), 400

    hood = data.get("neighborhood", "")

    def _line_total(it):
        try:
            return int(it.get("price", 0)) * int(it.get("qty", 0))
        except (TypeError, ValueError):
            return 0
    items_subtotal = sum(_line_total(it) for it in data["items"])

    def cart_signature(item_list):
        return sorted(
            (str(it.get("name", "")), int(it.get("qty", 0)))
            for it in item_list
        )

    new_sig = cart_signature(data["items"])

    with _orders_lock:
        orders = load_orders()
        now_dt = saudi_now()
        now = now_dt.strftime("%Y-%m-%d %H:%M:%S")

        for o in orders:
            if o.get("phone") != data["phone"]:
                continue
            try:
                placed = datetime.strptime(o.get("created_at", ""), "%Y-%m-%d %H:%M:%S")
            except ValueError:
                continue
            if now_dt - placed > timedelta(minutes=30):
                continue
            if cart_signature(o.get("items", [])) == new_sig:
                return jsonify({
                    "success": True, "order_id": o["id"], "duplicate": True,
                    "track_token": o.get("track_token", ""),
                })

        # Server-side pricing — never trust the client's total.
        # Free delivery: pickup (no hood), promo (subtotal >= threshold),
        # or loyalty reward (every LOYALTY_REWARD delivered orders).
        completed = sum(
            1 for o in orders
            if o.get("status") == "delivered" and o.get("phone", "") == data["phone"]
        )
        loyalty_free = completed > 0 and completed % LOYALTY_REWARD == 0
        if not hood:
            delivery_fee = 0
        elif items_subtotal >= FREE_DELIVERY_MIN or loyalty_free:
            delivery_fee = 0
        else:
            delivery_fee = NEIGHBORHOOD_FEES.get(hood, 5)

        # Re-validate the promo server-side (never trust the client's earlier
        # /api/promo/check result — state may have changed since). The gift is
        # appended AFTER items_subtotal/delivery_fee are already computed above,
        # so it never affects free-delivery or loyalty math regardless of price.
        promo_applied, promo_grocery = "", ""
        promo_code_in = data.get("promo_code", "")
        if promo_code_in:
            ok, _msg, grocery = _validate_promo(promo_code_in, data["phone"], orders)
            if ok:
                promo_applied, promo_grocery = promo_code_in.strip().upper(), grocery or ""

        order_items = list(data["items"])
        if promo_applied:
            order_items.append({"name": GIFT_ITEM_NAME, "price": 0, "qty": 1})

        order = {
            "id": (max((o["id"] for o in orders), default=0) + 1),
            "name": data["name"],
            "phone": data["phone"],
            "neighborhood": hood,
            # Which branch fulfils this order — derived from the hood for
            # delivery, from the customer's explicit choice for pickup.
            "branch": _resolve_branch(hood, data.get("branch", "")),
            "address": data.get("address", ""),
            "note": data.get("note", ""),
            "items": order_items,
            "total": items_subtotal + delivery_fee,
            "delivery_fee": delivery_fee,
            "promo_code": promo_applied,
            "promo_grocery": promo_grocery,
            # Captured delivery location (empty for pickup / older clients),
            # plus a soft flag when it fell outside the delivery radius.
            "lat": data.get("lat", ""),
            "lng": data.get("lng", ""),
            "out_of_range": bool(data.get("out_of_range", False)),
            # How the customer reached the site: "snap:<ScCid>" for a Snapchat ad
            # click, "utm:<source>", "ref:<host>", or "direct". Empty for orders
            # placed by clients running JS from before this field existed.
            "source": str(data.get("source", ""))[:120],
            "status": "draft",
            "created_at": now,
            "status_history": [{"status": "draft", "timestamp": now}],
            # Random token: track links can't be guessed by trying order numbers
            "track_token": secrets.token_urlsafe(8),
        }
        orders.append(order)
        save_orders(orders)
        return jsonify({
            "success": True, "order_id": order["id"],
            "track_token": order["track_token"],
        })


def _requested_branch():
    """Branch filter from ?branch= — '' means show every branch."""
    b = request.args.get("branch", "")
    return b if b in BRANCHES else ""


def _recent_orders(branch=""):
    """Most recent orders, newest first, capped for the dashboard.

    Each branch's tablet opens /admin?branch=<id> and sees only its own
    orders. Orders placed before branches existed have no "branch" key, so
    they fall back to the original branch.
    """
    all_orders = sorted(load_orders(), key=lambda o: o["id"], reverse=True)
    if branch:
        all_orders = [
            o for o in all_orders
            if o.get("branch", DEFAULT_BRANCH) == branch
        ]
    return all_orders[:ADMIN_RECENT_LIMIT], len(all_orders)


@app.route("/admin")
@require_admin
def admin():
    branch = _requested_branch()
    orders, _ = _recent_orders(branch)
    return render_template(
        "admin.html",
        orders=orders,
        promo_stats=_promo_stats(),
        branches=BRANCHES,
        active_branch=branch,
        default_branch=DEFAULT_BRANCH,
    )


@app.route("/api/admin/orders")
@require_admin
def admin_orders():
    branch = _requested_branch()
    orders, total = _recent_orders(branch)
    return jsonify({
        "orders": orders,
        "max_id": orders[0]["id"] if orders else 0,
        "count": total,
        "shown": len(orders),
        "promo_stats": _promo_stats(),
        "branch": branch,
    })


@app.route("/order/<int:order_id>/print")
@require_admin
def print_tag(order_id):
    orders = load_orders()
    for order in orders:
        if order["id"] == order_id:
            return render_template("print_tag.html", order=order)
    return "طلب غير موجود", 404


def _track_allowed(order):
    # Orders created before tokens existed stay reachable (legacy);
    # tokened orders need the right ?t= — or an admin login.
    stored = order.get("track_token", "")
    return (not stored) or request.args.get("t", "") == stored or _admin_ok()


@app.route("/order/<int:order_id>/track")
def track_order(order_id):
    orders = load_orders()
    for order in orders:
        if order["id"] == order_id:
            if not _track_allowed(order):
                return "رابط التتبع غير صالح — استخدم الرابط المرسل لك", 403
            return render_template("track.html", order=order)
    return "طلب غير موجود", 404


@app.route("/api/order/<int:order_id>/status", methods=["GET", "POST"])
def update_status(order_id):
    orders = load_orders()
    if request.method == "GET":
        for order in orders:
            if order["id"] == order_id:
                if not _track_allowed(order):
                    return jsonify({"error": "forbidden"}), 403
                return jsonify({
                    "status": order["status"],
                    "status_history": order.get("status_history", []),
                    "lat": order.get("lat", ""),
                    "lng": order.get("lng", ""),
                })
        return jsonify({"error": "Order not found"}), 404

    # POST = admin action (changing a status) → require login
    if not _admin_ok():
        return _admin_challenge()

    data = request.get_json()
    status = data.get("status")
    valid_statuses = ("draft", "pending", "confirmed", "preparing", "delivering", "delivered", "cancelled")
    if status not in valid_statuses:
        return jsonify({"error": "Invalid status"}), 400
    for order in orders:
        if order["id"] == order_id:
            order["status"] = status
            if "status_history" not in order:
                order["status_history"] = []
            order["status_history"].append({
                "status": status,
                "timestamp": saudi_now().strftime("%Y-%m-%d %H:%M:%S"),
            })
            save_orders(orders)
            return jsonify({"success": True})
    return jsonify({"error": "Order not found"}), 404


@app.route("/api/loyalty")
def loyalty():
    phone = request.args.get("phone", "").strip()
    if not phone:
        return jsonify({"error": "phone required"}), 400
    orders = load_orders()
    completed = [o for o in orders if o.get("status") == "delivered" and o.get("phone", "") == phone]
    count = len(completed)
    cycle_position = count % LOYALTY_REWARD
    orders_until_free = LOYALTY_REWARD - cycle_position
    reward_due = cycle_position == 0 and count > 0
    return jsonify({
        "completed_orders": count,
        "cycle_position": cycle_position,
        "orders_until_free_delivery": orders_until_free,
        "reward_due": reward_due,
    })


if __name__ == "__main__":
    os.makedirs(os.path.dirname(DATA_FILE), exist_ok=True)
    app.run(debug=True)
