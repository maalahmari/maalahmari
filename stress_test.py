#!/usr/bin/env python3
"""
Shawermat — stress & edge-case tester.
Generates an HTML report and opens it automatically.

Usage:
    python stress_test.py                   # targets https://www.shawermat.com
    python stress_test.py http://localhost:5000
"""
import json, sys, time, threading, urllib.request, urllib.error, os, webbrowser
from datetime import datetime

BASE_URL = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "https://www.shawermat.com"

# ── result store ──────────────────────────────────────────────────────────────────────────────────────────────────────
SECTIONS = []   # list of {title, rows:[{ok,label,detail,http,resp}]}
_current = None

def section(title):
    global _current
    _current = {"title": title, "rows": []}
    SECTIONS.append(_current)

def record(ok, label, detail="", http=None, resp=None):
    _current["rows"].append({
        "ok": ok, "label": label, "detail": detail,
        "http": http, "resp": json.dumps(resp, ensure_ascii=False)[:200] if resp else ""
    })

# ── HTTP helper ──────────────────────────────────────────────────────────────────────────────────────────
def req(path, body=None, method=None):
    url = BASE_URL + path
    if method is None:
        method = "GET" if body is None else "POST"
    data = json.dumps(body).encode("utf-8") if body is not None and method != "GET" else None
    r = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json"} if data else {},
        method=method,
    )
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        txt = e.read().decode("utf-8", errors="ignore")
        try:    return e.code, json.loads(txt)
        except: return e.code, {"raw": txt}
    except Exception as ex:
        return 0, {"error": str(ex)}

def check(label, status, resp, expect_key=None, expect_fail=False):
    notes = []
    ok = True
    if expect_fail:
        if status < 400:
            ok = False
            notes.append(f"يجب أن يرفض — لكن أعاد HTTP {status}")
    else:
        if status != 200:
            ok = False
            notes.append(f"HTTP {status} (متوقع 200)")
    if expect_key and expect_key not in resp:
        ok = False
        notes.append(f"مفتاح '{expect_key}' غير موجود في الرد")
    record(ok, label, " | ".join(notes), status, resp if not ok else None)

def good_order(**kw):
    base = {"name": "اختبار", "phone": "0509999999", "neighborhood": "الزهور",
            "items": [{"name": "شاورما ثوم", "qty": 2, "price": 7}], "total": 19}
    base.update(kw)
    return base

# ── TESTS ──────────────────────────────────────────────────────────────────────────────────────────────────────

def t1_edge_cases():
    section("1 — مدخلات خاطئة (يجب الرفض)")
    cases = [
        ("بيانات فارغة {}",                    {}),
        ("بدون اسم",                            {"phone":"0501234567","items":[{"name":"شاورما","qty":1,"price":7}],"total":12}),
        ("بدون رقم جوال",                       {"name":"أحمد","items":[{"name":"شاورما","qty":1,"price":7}],"total":12}),
        ("قائمة أصناف فارغة []",               {"name":"أحمد","phone":"0501234567","items":[],"total":0}),
        ("اسم فارغ '' ",                         good_order(name="")),
        ("رقم جوال فارغ ''",                   good_order(phone="", name="اختبار")),
    ]
    for label, body in cases:
        s, r = req("/api/order", body)
        check(label, s, r, expect_fail=True)

def t2_boundaries():
    section("2 — حدود البيانات (يجب القبول)")
    cases = [
        ("اسم طويل 500 حرف",        good_order(name="أ"*500, phone="0508881001")),
        ("XSS في الاسم",             good_order(name="<script>alert('xss')</script>", phone="0508881002")),
        ("إيموجي في الملاحظة",       good_order(note="🔥🌯💥 بدون بصل 🌶🌶🌶", phone="0508881003")),
        ("SQL injection في الاسم",   good_order(name="'; DROP TABLE orders; --", phone="0508881004")),
        ("50 صنف في طلب واحد",       good_order(items=[{"name":f"صنف {i}","qty":1,"price":7} for i in range(50)], total=350, phone="0508881007")),
    ]
    for label, body in cases:
        s, r = req("/api/order", body)
        check(label, s, r, expect_key="order_id")

    # These pass through — just log what the server returns
    for label, body in [
        ("إجمالي سالب -999",  good_order(total=-999, phone="0508881005")),
        ("إجمالي صفر",        good_order(total=0,    phone="0508881006")),
    ]:
        s, r = req("/api/order", body)
        detail = f"HTTP {s} — قبله السيرفر" if s == 200 else f"HTTP {s} — رفضه السيرفر"
        record(True, label + f" → {detail}", "", s, None)

def t3_duplicates():
    section("3 — حماية التكرار")
    order = good_order(phone="0507770001")
    s1, r1 = req("/api/order", order)
    check("الطلب الأول يُحفظ", s1, r1, expect_key="order_id")
    id1 = r1.get("order_id")

    time.sleep(0.4)
    s2, r2 = req("/api/order", order)
    is_dup = r2.get("duplicate") is True and r2.get("order_id") == id1
    record(is_dup, "نفس الطلب مرة ثانية → duplicate",
           "" if is_dup else f"duplicate={r2.get('duplicate')} | id1={id1} id2={r2.get('order_id')}")

    diff = good_order(phone="0507770001",
                      items=[{"name":"شاورما جبن","qty":1,"price":7},{"name":"بيبسي","qty":1,"price":4}], total=16)
    s3, r3 = req("/api/order", diff)
    not_dup = r3.get("duplicate") is not True
    record(not_dup, "نفس الجوال بسلة مختلفة → طلب جديد",
           "" if not_dup else "أعاد duplicate=True بالخطأ")

def t4_race():
    section("4 — Race Condition (10 طلبات متزامنة)")
    ids, errors = [], []
    lock = threading.Lock()

    def send(i):
        s, r = req("/api/order", good_order(phone=f"05066{i:05d}", name=f"عميل {i}"))
        with lock:
            if s == 200 and r.get("order_id"):
                ids.append(r["order_id"])
            else:
                errors.append((s, r))

    threads = [threading.Thread(target=send, args=(i,)) for i in range(10)]
    for t in threads: t.start()
    for t in threads: t.join()

    unique = len(set(ids))
    ok = unique == 10 and not errors
    detail = ""
    if unique < 10:
        detail = f"⚠️ تضارب! {10-unique} طلب ضاع أو تكرر ID"
    if errors:
        detail += f" | {len(errors)} خطأ"
    record(ok, f"10 threads متزامنة → {unique}/10 ID فريد", detail)
    record(True, f"IDs الناتجة: {sorted(set(ids))}", "", None, None)

def t5_volume():
    section("5 — حجم عالِ (20 طلب متتالي سريع)")
    ids, errors, start = [], [], time.time()
    for i in range(20):
        s, r = req("/api/order", good_order(phone=f"05088{i:05d}", name=f"عميل {i+1}"))
        if s == 200 and r.get("order_id"):
            ids.append(r["order_id"])
        else:
            errors.append((i+1, s, r))
        time.sleep(0.05)
    elapsed = time.time() - start
    ok = not errors
    detail = f"{len(ids)} نجح / {len(errors)} فشل / {elapsed:.1f}ث"
    if errors:
        detail += " | " + " | ".join(f"طلب#{i}: HTTP{s}" for i,s,r in errors[:3])
    record(ok, "20 طلب بفاصل 50ms", detail)

def t6_status():
    section("6 — Status API")
    s, r = req("/api/order", good_order(phone="0509000001", name="اختبار الحالة"))
    if s != 200:
        record(False, "لم يُنشأ الطلب التجريبي", f"HTTP {s}")
        return
    oid = r["order_id"]

    s2, r2 = req(f"/api/order/{oid}/status", method="GET")
    check(f"GET حالة طلب موجود #{oid}", s2, r2, expect_key="status")

    s3, r3 = req("/api/order/999999/status", method="GET")
    check("GET حالة طلب غير موجود (999999)", s3, r3, expect_fail=True)

    s4, r4 = req(f"/api/order/{oid}/status", {"status": "FAKE_STATUS"})
    check("POST حالة غير صحيحة بدون صلاحية → 401", s4, r4, expect_fail=True)

# ── HTML REPORT ─────────────────────────────────────────────────────────────────────────────────────

def build_html(ts, total_pass, total_fail):
    score_color = "#16a34a" if total_fail == 0 else "#dc2626"
    score_msg   = "🎉 اجتاز جميع الاختبارات!" if total_fail == 0 else f"⚠️ يوجد {total_fail} مشكلة تستحق المراجعة"

    rows_html = ""
    for sec in SECTIONS:
        sec_pass = sum(1 for r in sec["rows"] if r["ok"])
        sec_fail = len(sec["rows"]) - sec_pass
        badge = f'<span class="badge pass">{sec_pass} نجح</span>'
        if sec_fail:
            badge += f' <span class="badge fail">{sec_fail} فشل</span>'
        rows_html += f'<tr class="sec-header"><td colspan="3">{sec["title"]} {badge}</td></tr>\n'
        for row in sec["rows"]:
            cls = "pass-row" if row["ok"] else "fail-row"
            icon = "✅" if row["ok"] else "❌"
            detail = f'<div class="detail">{row["detail"]}</div>' if row["detail"] else ""
            resp   = f'<div class="resp">{row["resp"]}</div>'   if row["resp"]   else ""
            http   = f'<span class="http">HTTP {row["http"]}</span>' if row["http"] else ""
            rows_html += f'<tr class="{cls}"><td>{icon}</td><td>{row["label"]}{detail}{resp}</td><td>{http}</td></tr>\n'

    return f"""<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8"/>
<title>تقرير Stress Test — شاورمات</title>
<style>
  body{{font-family:'Segoe UI',Tahoma,sans-serif;background:#f4f4f5;margin:0;padding:24px;direction:rtl}}
  h1{{color:#cc0000;margin-bottom:4px}}
  .meta{{color:#666;font-size:.85rem;margin-bottom:20px}}
  .summary{{background:#fff;border-radius:12px;padding:20px 28px;margin-bottom:24px;
            box-shadow:0 2px 8px rgba(0,0,0,.08);display:flex;align-items:center;gap:24px}}
  .score{{font-size:2.2rem;font-weight:900;color:{score_color}}}
  .score-msg{{font-size:1.05rem;color:{score_color};font-weight:700}}
  .counters{{display:flex;gap:16px;margin-top:6px}}
  .cnt{{padding:6px 18px;border-radius:999px;font-weight:700;font-size:.95rem}}
  .cnt.p{{background:#dcfce7;color:#16a34a}} .cnt.f{{background:#fee2e2;color:#dc2626}}
  table{{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;
         overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)}}
  th{{background:#1e293b;color:#fff;padding:10px 14px;text-align:right;font-size:.85rem}}
  td{{padding:9px 14px;border-bottom:1px solid #f1f5f9;font-size:.88rem;vertical-align:top}}
  tr.sec-header td{{background:#f8fafc;font-weight:800;font-size:.95rem;color:#334155;padding:12px 14px}}
  tr.pass-row{{}} tr.fail-row{{background:#fff5f5}}
  .badge{{font-size:.75rem;padding:2px 10px;border-radius:999px;font-weight:700}}
  .badge.pass{{background:#dcfce7;color:#16a34a}} .badge.fail{{background:#fee2e2;color:#dc2626}}
  .detail{{color:#dc2626;font-size:.8rem;margin-top:3px}}
  .resp{{font-family:monospace;font-size:.75rem;background:#fef2f2;padding:4px 8px;
         border-radius:4px;margin-top:4px;color:#7f1d1d;word-break:break-all}}
  .http{{font-size:.78rem;color:#64748b;white-space:nowrap}}
  .url{{font-size:.78rem;color:#64748b;margin-bottom:20px}}
</style>
</head>
<body>
<h1>🌯 شاورمات — تقرير Stress Test</h1>
<div class="meta">الوقت: {ts} &nbsp;|&nbsp; الهدف: {BASE_URL}</div>
<div class="summary">
  <div>
    <div class="score">{total_pass}/{total_pass+total_fail}</div>
    <div class="score-msg">{score_msg}</div>
    <div class="counters">
      <span class="cnt p">✅ نجح {total_pass}</span>
      <span class="cnt f">❌ فشل {total_fail}</span>
    </div>
  </div>
</div>
<table>
  <thead><tr><th width="40"></th><th>الاختبار</th><th width="90">HTTP</th></tr></thead>
  <tbody>{rows_html}</tbody>
</table>
</body>
</html>"""

# ── MAIN ──────────────────────────────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"شاورمات Stress Test → {BASE_URL}")
    print("جاري التنفيذ...")

    t1_edge_cases()
    t2_boundaries()
    t3_duplicates()
    t4_race()
    t5_volume()
    t6_status()

    total_pass = sum(r["ok"] for s in SECTIONS for r in s["rows"])
    total_fail = sum(not r["ok"] for s in SECTIONS for r in s["rows"])

    report_path = os.path.join(os.path.dirname(__file__), "stress_report.html")
    with open(report_path, "w", encoding="utf-8") as f:
        f.write(build_html(ts, total_pass, total_fail))

    print(f"\nالنتيجة: {total_pass} نجح / {total_fail} فشل")
    print(f"التقرير: {report_path}")
    webbrowser.open(f"file:///{report_path.replace(chr(92), '/')}")
