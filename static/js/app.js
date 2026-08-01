/* ============================================
   SHAWERMAT — app.js
   ============================================ */

// Google Ads conversion tracking — never let a tracking failure touch the order flow.
function gtagSafe() {
  try {
    if (typeof gtag === 'function') gtag.apply(null, arguments);
  } catch (e) {}
}

var cart = {};
var DELIVERY = 5;          // both neighborhoods are 5 ريال; updated by selectHood()/selectPickup()
var selectedHood = null;   // set only at checkout (delivery/pickup chosen last)
var IS_PICKUP = false;
// Delivery-vs-pickup is now chosen at the END (checkout), not upfront. Until
// then the cart defaults to delivery (5 ريال, same for both hoods). This flag
// gates the mandatory method step so a delivery order can't ship without a
// specific neighborhood (server treats an empty neighborhood as free pickup).
var _methodChosen = false;
var _waOpened = false;     // true once WhatsApp opened, to hide re-send button on return
var _lastAddKey = null;    // last item added — for one-tap undo
var _lastAddQty = 1;

// Branch config comes from the server (window.BRANCHES / window.DEFAULT_BRANCH).
// _activeBranch is resolved at checkout: from the chosen neighborhood for
// delivery, or from the customer's explicit pick for pickup. Until then the
// default branch backs general contact links (chat FAB, footer, out-of-range).
var BRANCHES        = window.BRANCHES || {};
var DEFAULT_BRANCH  = window.DEFAULT_BRANCH || '';
var HOOD_TO_BRANCH  = window.HOOD_TO_BRANCH || {};
var _activeBranch   = DEFAULT_BRANCH;

function branchInfo(id) {
  return BRANCHES[id] || BRANCHES[DEFAULT_BRANCH] || {};
}
// Number that orders/links should use right now.
function waNumber()  { return branchInfo(_activeBranch).whatsapp || ''; }
function waDisplay() { return branchInfo(_activeBranch).display_phone || ''; }

// Working hours: 3:00 PM — 2:00 AM (next day). Same for both branches.
var OPEN_HOUR  = 15;
var CLOSE_HOUR = 2;

// "مشكل" flavor costs +1 SAR per sandwich
var MIXED_SURCHARGE = 1;

// Free-delivery promo: subtotal >= FREE_DELIVERY_MIN → free delivery.
// Between NUDGE and MIN → nudge the customer to top up to unlock it.
var FREE_DELIVERY_MIN   = 50;
var FREE_DELIVERY_NUDGE = 36;   // don't nudge about free delivery until the cart reaches this

// Delivery geofence (SOFT): we capture the customer's GPS at checkout to attach
// their location to the order and flag it for staff if it's outside the radius
// of the FULFILLING branch — but we never block the order. The branch is
// already resolved by the time we ask for location (hood is picked first).
var _deliveryCoords = null;          // {lat,lng,outOfRange} once we have a fix (or null)
var _deliveryLocationChecked = false; // asked for location already this order

// Grocery referral promo code (first order only) — {code, grocery} once the
// server validates it via /api/promo/check, else null.
var _appliedPromo = null;

function isMixedSelected(flavorGroupId) {
  var chip = document.querySelector('#' + flavorGroupId + ' .chip.active');
  return !!chip && chip.dataset.val === 'مشكل';
}

// Shop hours are Saudi hours, not the visitor's. getHours() would read the
// device clock, so a traveller — or anyone whose phone timezone is off — would
// see the wrong open/closed state and could be blocked from ordering while the
// shop is actually open. Saudi is UTC+3 year-round (no DST), so this is exact.
function saudiHour() {
  return (new Date().getUTCHours() + 3) % 24;
}

function isStoreOpen() {
  var h = saudiHour();
  return h >= OPEN_HOUR || h < CLOSE_HOUR;
}

function updateOpenStatus() {
  var open = isStoreOpen();
  var landing = document.getElementById('openStatusLanding');
  if (landing) {
    landing.classList.remove('is-open', 'is-closed');
    landing.classList.add(open ? 'is-open' : 'is-closed');
    landing.textContent = open ? '🟢 مفتوح الآن — حتى 2 صباحاً' : '🔴 مغلق الآن — نفتح 3 عصراً';
  }
  // Header: short text so it never overflows on mobile
  var header = document.getElementById('openStatusHeader');
  if (header) {
    header.classList.remove('is-open', 'is-closed');
    header.classList.add(open ? 'is-open' : 'is-closed');
    header.textContent = open ? '🟢 مفتوح' : '🔴 مغلق';
  }
  // When we cross the open/close boundary (this runs every minute), refresh the
  // cart so the checkout button enables/disables without a manual interaction.
  if (window._wasStoreOpen !== open) {
    window._wasStoreOpen = open;
    if (typeof renderCart === 'function') renderCart();
  }
}

// ── Per-card quantity state ──────────────────

var cardQty = {};

function changeCardQty(cardId, delta) {
  if (!cardQty[cardId]) cardQty[cardId] = 1;
  cardQty[cardId] = Math.max(1, cardQty[cardId] + delta);
  document.getElementById(cardId + '-qty-val').textContent = cardQty[cardId];
}

function getCardQty(cardId)  { return cardQty[cardId] || 1; }

function resetCardQty(cardId) {
  cardQty[cardId] = 1;
  var el = document.getElementById(cardId + '-qty-val');
  if (el) el.textContent = 1;
}

// ── Screen navigation ────────────────────────

function showMenuScreen() {
  document.getElementById('screen-landing').style.display = 'none';
  document.getElementById('screen-menu').style.display    = 'block';
  // Reveals شيفو's label — hidden on the landing so the order button owns it.
  document.body.classList.add('on-menu');
  refreshTrackButton();
}

// ── Neighborhood picker ──────────────────────

function openHoodPicker() {
  document.getElementById('hoodOverlay').classList.add('open');
  document.getElementById('hoodSheet').classList.add('open');
}

function closeHoodPicker() {
  document.getElementById('hoodOverlay').classList.remove('open');
  document.getElementById('hoodSheet').classList.remove('open');
}

// Delivery/pickup is chosen as the LAST step (from the cart's checkout button),
// so selecting a method now proceeds straight to the order form.
function selectHood(hood, fee) {
  closeHoodPicker();
  IS_PICKUP = false;
  selectedHood = hood;
  _methodChosen = true;
  // The hood decides which branch fulfils the order — the customer never
  // picks a branch for delivery. (Server re-derives this; never trusts us.)
  _activeBranch = HOOD_TO_BRANCH[hood] || DEFAULT_BRANCH;
  _deliveryCoords = null; _deliveryLocationChecked = false;   // re-capture location for this delivery
  DELIVERY = (typeof fee === 'number') ? fee : (window.NEIGHBORHOOD_FEES[hood] || 5);
  document.getElementById('hoodBadge').textContent = hood;
  renderCart();
  openOrderForm();
}

// Pickup is the one case with no hood to infer the branch from, so the
// customer picks which branch they're collecting from.
function selectPickup(branchId) {
  closeHoodPicker();
  IS_PICKUP = true;
  selectedHood = null;
  _methodChosen = true;
  _activeBranch = BRANCHES[branchId] ? branchId : DEFAULT_BRANCH;
  DELIVERY = 0;
  document.getElementById('hoodBadge').textContent = '🏪 ' + (branchInfo(_activeBranch).short || 'استلام');
  renderCart();
  openOrderForm();
}

function openRangeModal(title, msg) {
  var t = document.getElementById('rangeModalTitle');
  var m = document.getElementById('rangeModalMsg');
  if (t) t.textContent = title;
  if (m) m.textContent = msg;
  document.getElementById('outOfRangeModal').classList.add('open');
}

function showOutOfRange() {
  closeHoodPicker();
  // Built from the live hood list so it never goes stale when a branch or
  // neighborhood is added server-side.
  var hoods = Object.keys(window.NEIGHBORHOOD_FEES || {}).map(function(h) { return 'حي ' + h; });
  openRangeModal('خارج نطاق التوصيل', 'نوصّل حالياً لـ: ' + hoods.join('، ') + ' فقط');
}

function closeOutOfRange() {
  document.getElementById('outOfRangeModal').classList.remove('open');
}

// ── Delivery geofence ────────────────────────
// Great-circle distance (km) between two lat/lng points.
function haversineKm(lat1, lng1, lat2, lng2) {
  var R = 6371;
  var dLat = (lat2 - lat1) * Math.PI / 180;
  var dLng = (lng2 - lng1) * Math.PI / 180;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
          Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Soft geofence: capture the customer's location if they allow it, then ALWAYS
// continue via done(). We tag the coords with outOfRange so staff can double-check
// in the admin panel. Denied / failed / unsupported → just proceed without coords.
function captureDeliveryLocation(done) {
  _deliveryLocationChecked = true;
  if (!navigator.geolocation) { done(); return; }

  var coBtn = document.getElementById('checkoutBtn');
  var origText = coBtn ? coBtn.textContent : '';
  if (coBtn) { coBtn.disabled = true; coBtn.textContent = '📍 جاري تحديد موقعك…'; }
  function restore() { if (coBtn) { coBtn.disabled = false; coBtn.textContent = origText; } }

  // Checkout MUST continue exactly once, whichever path gets here first.
  var settled = false;
  function proceed() {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    restore();
    done();
  }

  // In-app browsers (Snapchat, Instagram) can swallow the permission prompt and
  // then never invoke either callback — the `timeout` option below is not
  // honoured in that case, so the button would stay disabled forever and the
  // customer is stranded on the cart. This watchdog is the real guarantee.
  var watchdog = setTimeout(proceed, 3500);

  navigator.geolocation.getCurrentPosition(
    function(pos) {
      if (settled) return;
      var lat = pos.coords.latitude, lng = pos.coords.longitude;
      var br = branchInfo(_activeBranch);
      var dist = haversineKm(lat, lng, br.lat, br.lng);
      _deliveryCoords = { lat: lat, lng: lng, outOfRange: dist > (br.radius_km || 2.2) };
      proceed();
    },
    proceed,   // denied / failed → carry on without coords (soft geofence)
    // The fix is only compared against a 2.2 km radius, so network-level accuracy
    // is plenty, and a short timeout keeps the button responsive.
    { enableHighAccuracy: false, timeout: 3000, maximumAge: 0 }
  );
}

// ── Snap Pixel identity ──────────────────────

var SNAP_PIXEL_ID = '1a588a86-d4d4-4844-b6d5-d9a9456d3cf4';

// Snap can only attribute a conversion to a Snapchatter if we hand it a hashed
// identifier — without one, Events Manager rates event quality "Poor" and
// conversion-optimised delivery has nothing to learn from. We have the phone at
// checkout, so hash it into the E.164 digits Snap expects (9665XXXXXXXX).
async function snapHashedPhone(localPhone) {
  var norm = normalizeSaudiPhone(localPhone);
  if (!norm || !window.crypto || !crypto.subtle) return null;
  try {
    var digits = '966' + norm.slice(1);
    var buf    = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(digits));
    return Array.prototype.map.call(new Uint8Array(buf), function(b) {
      return ('0' + b.toString(16)).slice(-2);
    }).join('');
  } catch (e) { return null; }
}

// scevent.min.js drops a first-party `_scid` cookie; Snap asks for its value
// back as uuid_c1 to raise the match rate. It is set once the SDK has loaded,
// so callers late in the funnel will find it even if page load did not.
function snapScid() {
  var m = document.cookie.match(/(?:^|;\s*)_scid=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// Re-init the pixel with whatever identifiers we have. Snap treats a repeat
// init as an identity update, so events tracked afterwards carry them.
async function snapIdentify(localPhone) {
  if (typeof snaptr !== 'function') return;
  var ids    = {};
  var hashed = await snapHashedPhone(localPhone);
  var scid   = snapScid();
  if (hashed) ids.user_hashed_phone_number = hashed;
  if (scid)   ids.uuid_c1 = scid;
  if (Object.keys(ids).length) snaptr('init', SNAP_PIXEL_ID, ids);
}

// ── Cart core ────────────────────────────────

function addToCart(key, name, price, qty) {
  qty = qty || 1;
  if (cart[key]) {
    cart[key].qty += qty;
  } else {
    cart[key] = { name: name, price: price, qty: qty };
  }
  _lastAddKey = key;
  _lastAddQty = qty;
  renderCart();

  gtagSafe('event', 'add_to_cart', {
    currency: 'SAR',
    value: price * qty,
    items: [{ item_name: name }],
  });

  if (typeof snaptr === 'function') {
    snaptr('track', 'ADD_CART', { item_ids: [key], price: price * qty, currency: 'SAR' });
  }
}

function changeQtyByIndex(idx, delta) {
  var key = window._cartKeys && window._cartKeys[idx];
  if (!key || !cart[key]) return;
  cart[key].qty += delta;
  if (cart[key].qty <= 0) delete cart[key];
  renderCart();
}

function renderCart() {
  var itemsEl   = document.getElementById('cartItems');
  var totalEl   = document.getElementById('cartTotal');
  var actionsEl = document.getElementById('cartActions');
  var countEl   = document.getElementById('cartCount');

  var keys = Object.keys(cart);
  window._cartKeys = keys;
  var totalQty = keys.reduce(function(s, k) { return s + cart[k].qty; }, 0);
  if (countEl) countEl.textContent = totalQty;

  if (keys.length === 0) {
    itemsEl.innerHTML = '<p class="empty-msg">السلة فارغة</p>';
    totalEl.style.display   = 'none';
    actionsEl.style.display = 'none';
    updateLoyaltyBar();
    return;
  }

  itemsEl.innerHTML = keys.map(function(key, idx) {
    var item = cart[key];
    return '<div class="cart-item">' +
      '<div class="cart-item-info">' +
        '<h4>' + item.name + '</h4>' +
        '<span>' + (item.price * item.qty) + ' ريال</span>' +
      '</div>' +
      '<div class="qty-controls">' +
        '<button class="qty-btn" onclick="changeQtyByIndex(' + idx + ', -1)">−</button>' +
        '<span class="qty-val">' + item.qty + '</span>' +
        '<button class="qty-btn" onclick="changeQtyByIndex(' + idx + ', 1)">+</button>' +
      '</div>' +
    '</div>';
  }).join('');

  var subtotal = getSubtotal();
  var loyaltyRewardDue = window._loyaltyRewardDue || false;
  var freeDeliveryPromo = !IS_PICKUP && !loyaltyRewardDue && subtotal >= FREE_DELIVERY_MIN;
  var deliveryFee = getDeliveryFee();   // 0 for pickup / loyalty / promo

  var deliveryText;
  if (IS_PICKUP)              deliveryText = 'بدون توصيل 🏪';
  else if (loyaltyRewardDue)  deliveryText = 'مجاناً 🎁';
  else if (freeDeliveryPromo) deliveryText = 'مجاناً 🎉 (خصم ' + DELIVERY + ' ريال)';
  else                        deliveryText = deliveryFee + ' ريال';

  var deliveryLabel = document.getElementById('deliveryLabel');
  if (deliveryLabel) deliveryLabel.textContent = IS_PICKUP ? 'الاستلام' : 'التوصيل';
  document.getElementById('subtotalVal').textContent = subtotal + ' ريال';
  document.getElementById('deliveryVal').textContent = deliveryText;
  document.getElementById('totalVal').textContent    = (IS_PICKUP ? subtotal : subtotal + deliveryFee) + ' ريال';

  // Free-delivery progress line — same box treatment as the minimum-order
  // line. Shows for a paid neighborhood while the SUBTOTAL is still under the
  // threshold; once ≥ 50 the delivery row above already reads "مجاناً 🎉".
  var promoNote = document.getElementById('promoNote');
  if (promoNote) {
    var paidHood = !IS_PICKUP && !loyaltyRewardDue;   // pickup & loyalty are already free
    if (paidHood && subtotal >= FREE_DELIVERY_NUDGE && subtotal < FREE_DELIVERY_MIN) {
      promoNote.style.cssText = 'display:block;background:#e8f7ee;color:#166534;border-radius:8px;padding:.55rem .8rem;font-size:.85rem;margin:0 0 .6rem;text-align:center;line-height:1.5;font-weight:700';
      promoNote.textContent = 'باقي ' + (FREE_DELIVERY_MIN - subtotal) + ' ريال للتوصيل المجاني 🎉';
    } else {
      promoNote.style.display = 'none';
    }
  }
  totalEl.style.display   = 'block';
  actionsEl.style.display = 'block';

  // Minimum-order gate — inline notice (works inside WhatsApp's in-app browser)
  var minNote = document.getElementById('minOrderNote');
  var coBtn   = document.getElementById('checkoutBtn');
  var remaining = MIN_ORDER - subtotal;
  if (!isStoreOpen()) {
    // Closed: allow browsing/building the cart, but block checkout until we open.
    if (minNote) {
      minNote.style.display = 'block';
      minNote.textContent = '🔴 مغلق الآن — نفتح 3 العصر. جهّز طلبك واطلبه وقت الفتح 🌯';
    }
    if (coBtn) { coBtn.disabled = true; coBtn.style.opacity = '0.5'; coBtn.style.cursor = 'not-allowed'; }
  } else if (remaining > 0) {
    if (minNote) {
      minNote.style.display = 'block';
      minNote.textContent = '🛒 باقي ' + remaining + ' ريال للوصول للحد الأدنى (' + MIN_ORDER + ' ريال)';
    }
    if (coBtn) { coBtn.disabled = true; coBtn.style.opacity = '0.5'; coBtn.style.cursor = 'not-allowed'; }
  } else {
    if (minNote) minNote.style.display = 'none';
    if (coBtn)   { coBtn.disabled = false; coBtn.style.opacity = ''; coBtn.style.cursor = ''; }
  }

  updateLoyaltyBar();
}

function getSubtotal() {
  return Object.values(cart).reduce(function(s, i) { return s + i.price * i.qty; }, 0);
}

function getDeliveryFee() {
  if (IS_PICKUP) return 0;
  if (window._loyaltyRewardDue) return 0;
  if (getSubtotal() >= FREE_DELIVERY_MIN) return 0;   // free-delivery promo
  return DELIVERY;
}

// Returns a recent order id (placed within last 3 hours) or null.
// Old/stale orders auto-expire so the track button never points at a
// non-existent order from earlier testing.
var TRACK_WINDOW_MS = 3 * 60 * 60 * 1000;

function getTrackableOrderId() {
  try {
    var raw = localStorage.getItem('sw_track');
    if (!raw) return null;
    var t = JSON.parse(raw);
    if (!t || !t.id) return null;
    if (Date.now() - (t.at || 0) > TRACK_WINDOW_MS) return null;
    return t.id;
  } catch (e) { return null; }
}

function refreshTrackButton() {
  var btn = document.getElementById('trackBtnHeader');
  if (!btn) return;
  var id = getTrackableOrderId();
  if (id) {
    btn.style.display = 'inline-block';
    btn.textContent   = '📍 تتبع #' + id;
    btn._orderId      = id;
  } else {
    btn.style.display = 'none';
  }
}

function getTrackToken() {
  try {
    var t = JSON.parse(localStorage.getItem('sw_track') || 'null');
    return (t && t.t) ? t.t : '';
  } catch (e) { return ''; }
}

function trackUrlFor(id) {
  var tok = getTrackToken();
  return '/order/' + id + '/track' + (tok ? '?t=' + encodeURIComponent(tok) : '');
}

function goTrackOrder() {
  var id = getTrackableOrderId();
  if (id) window.open(trackUrlFor(id), '_blank');
}

// ── Loyalty bar ───────────────────────────────

function updateLoyaltyBar() {
  var bar = document.getElementById('loyaltyBar');
  if (!bar) return;
  var data = window._loyaltyData;
  if (!data) { bar.classList.remove('visible'); return; }

  bar.classList.add('visible');
  var dots = '';
  for (var i = 0; i < 4; i++) {
    dots += '<div class="loyalty-dot' + (i < data.cycle_position ? ' filled' : '') + '"></div>';
  }

  if (data.reward_due) {
    bar.innerHTML = '<strong>التوصيل مجاني في طلبك القادم!</strong> 🎁<div class="loyalty-progress">' + dots + '</div>';
  } else {
    bar.innerHTML = 'بعد <strong>' + data.orders_until_free_delivery + '</strong> طلبات: توصيل مجاني!<div class="loyalty-progress">' + dots + '</div>';
  }
}

async function fetchLoyalty(phone) {
  if (!phone) return;
  try {
    var res  = await fetch('/api/loyalty?phone=' + encodeURIComponent(phone));
    var data = await res.json();
    if (!data.error) {
      window._loyaltyData      = data;
      window._loyaltyRewardDue = data.reward_due;
      updateLoyaltyBar();
      renderCart();
    }
  } catch (e) {}
}

// ── Cart sidebar ─────────────────────────────

function openCart() {
  document.getElementById('cartSidebar').classList.add('open');
  document.getElementById('cartOverlay').classList.add('open');
}

function closeCart() {
  document.getElementById('cartSidebar').classList.remove('open');
  document.getElementById('cartOverlay').classList.remove('open');
}

function toggleCart() {
  document.getElementById('cartSidebar').classList.toggle('open');
  document.getElementById('cartOverlay').classList.toggle('open');
}

// ── Category tabs ─────────────────────────────

function showCategory(cat, btn) {
  document.querySelectorAll('.conf-grid').forEach(function(el) { el.style.display = 'none'; });
  document.querySelectorAll('.tab').forEach(function(el) { el.classList.remove('active'); });
  document.getElementById('cat-' + cat).style.display = 'grid';
  btn.classList.add('active');
}

// Broasted comes عادي or سبايسي (and 4/8 قطع), so it can't be a one-tap quick-add
// like the other popular items — send the customer to its full card to choose.
function focusBroasted() {
  var tab = Array.prototype.filter.call(document.querySelectorAll('.tab'), function(el) {
    return (el.getAttribute('onclick') || '').indexOf("'broasted'") !== -1;
  })[0];
  if (tab) tab.click();   // switches category + sets the tab active
  var grid = document.getElementById('cat-broasted');
  if (grid) grid.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ── Shawarma price update ────────────────────

function updateSwPrice() {
  var chip  = document.querySelector('#sw-flavor .chip.active');
  var price = chip ? parseInt(chip.dataset.price) : 7;
  var el    = document.getElementById('sw-price');
  if (el) el.textContent = price + ' ريال';
}

// ── MAIN item add functions (trigger upsell) ─

function addSandwich() {
  var chip   = document.querySelector('#sw-flavor .chip.active');
  var flavor = chip ? chip.dataset.val   : 'مايونيز';
  var price  = chip ? parseInt(chip.dataset.price) : 7;
  var name   = 'شاورما ' + flavor;
  addToCart(name, name, price, getCardQty('sw'));
  resetCardQty('sw');
  updateSwPrice();
  showFriesUpsell();
}

function addFlavorFixed(baseName, fixedPrice, flavorGroupId, cardId) {
  var chip   = document.querySelector('#' + flavorGroupId + ' .chip.active');
  var flavor = chip ? chip.dataset.val : 'مايونيز';
  var name   = baseName + ' ' + flavor;
  var price  = fixedPrice + (flavor === 'مشكل' ? MIXED_SURCHARGE : 0);
  addToCart(name, name, price, getCardQty(cardId));
  resetCardQty(cardId);
  showFriesUpsell();
}

// Fixed-price meal with flavor choice
function addMealFlavorFixed(baseName, fixedPrice, flavorGroupId, cardId) {
  var chip   = document.querySelector('#' + flavorGroupId + ' .chip.active');
  var flavor = chip ? chip.dataset.val : 'مايونيز';
  var name   = baseName + ' ' + flavor;
  var price  = fixedPrice + (flavor === 'مشكل' ? MIXED_SURCHARGE : 0);
  var q      = getCardQty(cardId);
  addToCart(name, name, price, q);
  resetCardQty(cardId);
  showMealUpsell(q);   // these meals have 1 fries each
}

function addMeal(name, price, cardId) {
  var q = getCardQty(cardId);
  addToCart(name, name, price, q);
  resetCardQty(cardId);
  showMealUpsell(q);   // 1 fries each
}

function addMealConf(groupId, cardId, namePrefix) {
  var chip = document.querySelector('#' + groupId + ' .chip.active');
  if (!chip) return;
  var name  = namePrefix + ' ' + chip.dataset.val;
  var price = parseInt(chip.dataset.price);
  var q     = getCardQty(cardId);
  addToCart(name, name, price, q);
  resetCardQty(cardId);
  showMealUpsell(q);   // 1 fries each
}

function addMealFlavored(sizeGroupId, flavorGroupId, cardId, prefix) {
  var sizeChip   = document.querySelector('#' + sizeGroupId   + ' .chip.active');
  var flavorChip = document.querySelector('#' + flavorGroupId + ' .chip.active');
  if (!sizeChip) return;
  var flavor = flavorChip ? flavorChip.dataset.val : 'مايونيز';
  var count  = parseInt(sizeChip.dataset.count || '1');
  var price  = parseInt(sizeChip.dataset.price) + (flavor === 'مشكل' ? MIXED_SURCHARGE * count : 0);
  var name   = prefix + ' ' + sizeChip.dataset.val + ' ' + flavor;
  var q      = getCardQty(cardId);
  addToCart(name, name, price, q);
  resetCardQty(cardId);
  // Family meal comes with 3 fries; every other meal has 1.
  var friesPerMeal = (prefix === 'وجبة عائلية') ? 3 : 1;
  showMealUpsell(friesPerMeal * q);
}

function addArabicSwConf() {
  var sizeChip   = document.querySelector('#arabic-sw-size .chip.active');
  var flavorChip = document.querySelector('#arabic-sw-flavor .chip.active');
  if (!sizeChip) return;
  var size   = sizeChip.dataset.val;
  var flavor = flavorChip ? flavorChip.dataset.val : 'ثوم';
  var price  = parseInt(sizeChip.dataset.price) + (flavor === 'مشكل' ? MIXED_SURCHARGE : 0);
  var name   = 'شاورما عربي ' + size + ' ' + flavor;
  addToCart(name, name, price, getCardQty('arabic-sw'));
  resetCardQty('arabic-sw');
  showFriesUpsell();
}

function addMainConf(groupId, cardId, namePrefix) {
  var chip = document.querySelector('#' + groupId + ' .chip.active');
  if (!chip) return;
  var name  = namePrefix + ' ' + chip.dataset.val;
  var price = parseInt(chip.dataset.price);
  var qty   = getCardQty(cardId);
  addToCart(name, name, price, qty);
  resetCardQty(cardId);
  showFriesUpsell();
}

function addMainSimple(name, price, cardId) {
  var qty = getCardQty(cardId);
  addToCart(name, name, price, qty);
  resetCardQty(cardId);
  showFriesUpsell();
}

function addBroastedConf() {
  var sizeChip = document.querySelector('#broasted-size .chip.active');
  var typeChip = document.querySelector('#broasted-type .chip.active');
  var size  = sizeChip ? sizeChip.dataset.val       : 'حصة';
  var type  = typeChip ? typeChip.dataset.val        : 'عادي';
  var price = sizeChip ? parseInt(sizeChip.dataset.price) : 19;
  var name  = 'بروستد ' + size + ' ' + type;
  addToCart(name, name, price, getCardQty('broasted'));
  resetCardQty('broasted');
  showFriesUpsell();
}

// Quick-add from popular section
function quickAdd(name, price, triggerUpsell) {
  addToCart(name, name, price, 1);
  if (triggerUpsell) {
    showFriesUpsell();
  } else {
    showAddedToast();
  }
}

// Quick-add meal from popular section → meal upsell
function quickAddMeal(name, price) {
  addToCart(name, name, price, 1);
  showMealUpsell();
}

// Quick-add from the hero meal cards (landing screen) — the low-friction path:
// drop the meal in the cart AND enter the app (menu screen) in one tap. The
// delivery/pickup choice is deferred to checkout, so there's nothing to ask here.
function heroQuickAdd(name, price) {
  addToCart(name, name, price, 1);
  showAddedToast();
  showMenuScreen();
}

// ── Rotating hero meal photo (landing screen) ─
// Cycles the meal photos in one large card, keeping the price in sync. Add a
// 4th meal by adding another <img class="hero-solo-img"> with data-name /
// data-price — no JS change needed.
var HERO_SOLO_MS = 3000;
var _heroSoloTimer = null;
var _heroSoloIdx = 0;
var _heroSoloFrozen = false;

function heroSoloImgs() { return document.querySelectorAll('.hero-solo-img'); }

function showHeroSolo(i) {
  var imgs = heroSoloImgs();
  if (!imgs.length) return;
  i = ((i % imgs.length) + imgs.length) % imgs.length;
  _heroSoloIdx = i;

  for (var n = 0; n < imgs.length; n++) {
    imgs[n].classList.toggle('is-active', n === i);
  }

  var cur   = imgs[i];
  var price = document.getElementById('heroSoloPrice');
  var badge = document.getElementById('heroSoloBadge');
  var dots  = document.getElementById('heroSoloDots');
  if (price) price.textContent = cur.dataset.price + ' ريال';
  if (badge) {
    var label = cur.dataset.badge || '';
    badge.textContent = label;
    badge.style.display = label ? '' : 'none';
  }
  if (dots) {
    dots.innerHTML = Array.prototype.map.call(imgs, function(_, n) {
      return '<i class="' + (n === i ? 'on' : '') + '"></i>';
    }).join('');
  }
}

// Stop rotating as soon as the customer reaches for the card: otherwise the
// photo could change between press and release and add the wrong meal.
function freezeHeroSolo() {
  _heroSoloFrozen = true;
  if (_heroSoloTimer) { clearInterval(_heroSoloTimer); _heroSoloTimer = null; }
}

function initHeroSolo() {
  var card = document.getElementById('heroSolo');
  var imgs = heroSoloImgs();
  if (!card || !imgs.length) return;

  showHeroSolo(0);
  card.addEventListener('pointerdown', freezeHeroSolo);   // fires before click
  card.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); heroSoloAdd(); }
  });

  if (imgs.length < 2) return;
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion) return;   // leave the first photo showing, no auto-change
  _heroSoloTimer = setInterval(function() {
    if (_heroSoloFrozen) return;
    showHeroSolo(_heroSoloIdx + 1);
  }, HERO_SOLO_MS);
}

// Adds whatever meal is on screen right now.
function heroSoloAdd() {
  freezeHeroSolo();
  var cur = heroSoloImgs()[_heroSoloIdx];
  if (!cur) return;
  heroQuickAdd(cur.dataset.name, parseInt(cur.dataset.price, 10));
}

// ── EXTRA item add functions (open cart directly) ─

function addExtraConf(groupId, cardId, namePrefix) {
  var chip = document.querySelector('#' + groupId + ' .chip.active');
  if (!chip) return;
  var name  = namePrefix + ' ' + chip.dataset.val;
  var price = parseInt(chip.dataset.price);
  var qty   = getCardQty(cardId);
  addToCart(name, name, price, qty);
  resetCardQty(cardId);
  showAddedToast();
}

function addExtraSimple(name, price, cardId) {
  var qty = getCardQty(cardId);
  addToCart(name, name, price, qty);
  resetCardQty(cardId);
  showAddedToast();
}

// Soft drink: flat price, flavor choice only
var DRINK_PRICE = 4;
var MIN_ORDER   = 25;

function addDrinkConf() {
  var chip = document.querySelector('#drink-flavor .chip.active');
  var name = chip ? chip.dataset.val : 'بيبسي';
  addToCart(name, name, DRINK_PRICE, getCardQty('drink'));
  resetCardQty('drink');
  showAddedToast();
}

// ── Upsell: Fries ────────────────────────────

function showFriesUpsell() {
  initUpsellChips('upsell-fries-chips');
  document.getElementById('upsellFriesModal').classList.add('open');
}

function addUpsellFries() {
  var chip  = document.querySelector('#upsell-fries-chips .chip.active');
  var size  = chip ? chip.dataset.val   : 'صغير';
  var price = chip ? parseInt(chip.dataset.price) : 5;
  addToCart('بطاطس ' + size + ' upsell', 'بطاطس ' + size, price, 1);
  document.getElementById('upsellFriesModal').classList.remove('open');
  showDrinkUpsell();
}

function showDrinkUpsell() {
  document.getElementById('upsellFriesModal').classList.remove('open');
  initUpsellChips('upsell-drink-chips');
  document.getElementById('upsellDrinkModal').classList.add('open');
}

// ── Upsell: Drink ────────────────────────────

function addUpsellDrink() {
  var chip  = document.querySelector('#upsell-drink-chips .chip.active');
  var name  = chip ? chip.dataset.val   : 'بيبسي';
  var price = chip ? parseInt(chip.dataset.price) : DRINK_PRICE;
  addToCart(name + ' upsell', name, price, 1);
  closeUpsellDrink();
}

function closeUpsellDrink() {
  document.getElementById('upsellDrinkModal').classList.remove('open');
  showAddedToast();
}

// ── Upsell: Meal extras (fries upgrade → sauce) ─

// A meal comes with a set number of fries (family meal = 3, all others = 1).
// The customer picks how many of them to upgrade to large, at 5 ريال each.
var FRIES_UPGRADE_PRICE = 5;
var _mealFriesMax = 1;
var _mealFriesQty = 1;

function showMealUpsell(friesCount) {
  _mealFriesMax = Math.max(1, friesCount || 1);
  _mealFriesQty = 1;
  renderMealFriesUpsell();
  document.getElementById('upsellMealFriesModal').classList.add('open');
}

function renderMealFriesUpsell() {
  var multi  = _mealFriesMax > 1;
  var qtyRow = document.getElementById('mealFriesQtyRow');
  var qtyVal = document.getElementById('mealFriesQtyVal');
  var sub    = document.getElementById('mealFriesSubtitle');
  var addBtn = document.getElementById('mealFriesAddBtn');
  if (qtyRow) qtyRow.style.display = multi ? 'flex' : 'none';
  if (qtyVal) qtyVal.textContent = _mealFriesQty;
  if (sub) sub.textContent = multi
    ? ('وجبتك فيها ' + _mealFriesMax + ' بطاطس — كل تكبيرة ' + FRIES_UPGRADE_PRICE + ' ريال، اختر كم تكبّر')
    : ('ترقية من صغير لكبير — ' + FRIES_UPGRADE_PRICE + ' ريال فقط');
  if (addBtn) addBtn.textContent = multi
    ? ('➕ كبّر ' + _mealFriesQty + ' — ' + (_mealFriesQty * FRIES_UPGRADE_PRICE) + ' ريال')
    : ('➕ كبّر البطاطس — ' + FRIES_UPGRADE_PRICE + ' ريال');
}

function changeMealFriesQty(delta) {
  _mealFriesQty = Math.min(_mealFriesMax, Math.max(1, _mealFriesQty + delta));
  renderMealFriesUpsell();
}

function addMealFriesUpgrade() {
  addToCart('ترقية البطاطس upsell', 'ترقية البطاطس لكبير', FRIES_UPGRADE_PRICE, _mealFriesQty);
  showMealSauceUpsell();
}

function showMealSauceUpsell() {
  document.getElementById('upsellMealFriesModal').classList.remove('open');
  initUpsellChips('upsell-meal-sauce-chips');
  document.getElementById('upsellMealSauceModal').classList.add('open');
}

function addUpsellMealSauce() {
  var chip  = document.querySelector('#upsell-meal-sauce-chips .chip.active');
  var name  = chip ? chip.dataset.val   : 'ثوم';
  var price = chip ? parseInt(chip.dataset.price) : 2;
  addToCart('صوص ' + name + ' upsell', 'صوص ' + name, price, 1);
  closeMealSauceUpsell();
}

function closeMealSauceUpsell() {
  document.getElementById('upsellMealSauceModal').classList.remove('open');
  showAddedToast();
}

// ── Close / undo helpers for upsell flow ─────

var _UPSELL_IDS = ['upsellFriesModal','upsellDrinkModal','upsellMealFriesModal','upsellMealSauceModal'];

function hideAllUpsellModals() {
  _UPSELL_IDS.forEach(function(id) {
    var m = document.getElementById(id);
    if (m) m.classList.remove('open');
  });
}

// One-tap escape from the upsell flow (item already in cart stays)
function closeAllUpsells() {
  hideAllUpsellModals();
  showAddedToast();
}

// Mis-click recovery: remove the just-added item and close the flow
function undoLastAdd() {
  if (_lastAddKey && cart[_lastAddKey]) {
    cart[_lastAddKey].qty -= _lastAddQty;
    if (cart[_lastAddKey].qty <= 0) delete cart[_lastAddKey];
    renderCart();
  }
  _lastAddKey = null;
  hideAllUpsellModals();
  var t = document.getElementById('addedToast');
  if (t) {
    t.textContent = '↩ تم التراجع';
    t.classList.add('show');
    setTimeout(function() { t.classList.remove('show'); t.textContent = '✅ أُضيف للسلة'; }, 1600);
  }
}

function showAddedToast() {
  var t = document.getElementById('addedToast');
  if (!t) return;
  t.classList.add('show');
  setTimeout(function() { t.classList.remove('show'); }, 2000);
}

function initUpsellChips(groupId) {
  var g = document.getElementById(groupId);
  if (!g) return;
  g.querySelectorAll('.chip').forEach(function(chip) {
    chip.addEventListener('click', function() {
      g.querySelectorAll('.chip').forEach(function(c) { c.classList.remove('active'); });
      chip.classList.add('active');
    });
  });
}

// ── GPS Location ─────────────────────────────


// ── Order form ────────────────────────────────

// Checkout entry point from the cart. Enforces the same open/minimum gates as
// openOrderForm, then — if the customer hasn't chosen delivery vs pickup yet —
// shows that choice as the final step (bottom sheet) before the order form.
function startCheckout() {
  if (Object.keys(cart).length === 0) return;
  if (!isStoreOpen()) { openCart(); renderCart(); return; }
  if (getSubtotal() < MIN_ORDER) { openCart(); renderCart(); return; }
  if (!_methodChosen) { closeCart(); openHoodPicker(); return; }
  openOrderForm();
}

function openOrderForm() {
  var keys = Object.keys(cart);
  if (keys.length === 0) return;

  // Closed: keep the cart open and show the "مغلق الآن" notice; don't proceed.
  if (!isStoreOpen()) {
    openCart();
    renderCart();
    return;
  }

  // Below minimum: keep the cart open and show the inline notice (no native alert)
  if (getSubtotal() < MIN_ORDER) {
    openCart();
    renderCart();
    return;
  }

  // Delivery orders: capture the customer's location once (soft — never blocks),
  // then continue. Pickup skips this.
  if (!IS_PICKUP && !_deliveryLocationChecked) {
    captureDeliveryLocation(openOrderForm);
    return;
  }

  closeCart();

  gtagSafe('event', 'begin_checkout', {
    currency: 'SAR',
    value: getSubtotal(),
  });

  if (typeof snaptr === 'function') {
    // `_scid` is reliably present by now even if it was not at page load.
    // snapIdentify hashes asynchronously, so track from the promise — otherwise
    // the identity init lands after the event it was meant to identify.
    var savedAtCheckout = getSavedCustomer();
    var checkoutPayload = {
      price:        getSubtotal(),
      currency:     'SAR',
      item_ids:     Object.keys(cart),
      number_items: Object.keys(cart).reduce(function(n, k) { return n + cart[k].qty; }, 0),
    };
    snapIdentify(savedAtCheckout && savedAtCheckout.phone).then(function() {
      snaptr('track', 'START_CHECKOUT', checkoutPayload);
    });
  }

  // Adjust modal for pickup vs delivery
  var modalTitle = document.querySelector('#orderModal .modal-header h2');
  if (modalTitle) modalTitle.textContent = IS_PICKUP ? 'بيانات الطلب' : 'بيانات التوصيل';
  var locNote = document.getElementById('locationNote');
  if (locNote) locNote.style.display = IS_PICKUP ? 'none' : '';
  var submitBtn = document.getElementById('submitBtn');
  if (submitBtn) submitBtn.textContent = IS_PICKUP ? '🏪 تأكيد طلب الاستلام عبر واتساب' : '📲 تأكيد الطلب عبر واتساب';

  // Pre-fill saved customer details
  var saved = getSavedCustomer();
  if (saved) {
    if (saved.name  && !document.getElementById('custName').value)    document.getElementById('custName').value    = saved.name;
    if (saved.phone && !document.getElementById('custPhone').value)   document.getElementById('custPhone').value   = saved.phone;
    if (saved.address && !document.getElementById('custAddress').value) document.getElementById('custAddress').value = saved.address;
  }

  var subtotal = getSubtotal();
  var delivery = getDeliveryFee();
  var total    = subtotal + delivery;
  var lines    = keys.map(function(k) {
    return '<li>' + cart[k].qty + '× ' + cart[k].name + ' — ' + (cart[k].price * cart[k].qty) + ' ريال</li>';
  }).join('');
  var deliveryText;
  if (delivery === 0 && window._loyaltyRewardDue) deliveryText = 'مجاناً (مكافأة الولاء) 🎁';
  else if (delivery === 0)                        deliveryText = 'مجاناً (خصم ' + DELIVERY + ' ريال) 🎉';
  else                                            deliveryText = delivery + ' ريال';
  var totalLine    = IS_PICKUP
    ? '<p class="summary-total">🏪 استلام من المحل (بدون رسوم توصيل) — الإجمالي: ' + subtotal + ' ريال</p>'
    : '<p class="summary-total">الإجمالي (شامل ' + deliveryText + ' توصيل): ' + total + ' ريال</p>';

  var closedNotice = isStoreOpen() ? '' :
    '<p style="background:#fff3e0;color:#b45309;border-radius:8px;padding:.6rem .8rem;font-size:.85rem;margin-bottom:.75rem;line-height:1.5">' +
    '⏰ المطعم مغلق الآن — تقدر تكمل طلبك، وبيبدأ التحضير مع بداية الدوام (3 عصراً).</p>';

  document.getElementById('modalSummary').innerHTML =
    closedNotice +
    '<h4>ملخص الطلب</h4><ul>' + lines + '</ul>' + totalLine;

  resetPromoState();   // fresh review screen → no stale code/gift from a previous attempt
  document.getElementById('orderModal').classList.add('open');
}

function closeOrderForm() {
  document.getElementById('orderModal').classList.remove('open');
}

// ── Promo codes (grocery referral, first order only) ─
function renderPromoGiftLine() {
  var el = document.getElementById('promoGiftLine');
  if (!el) return;
  if (_appliedPromo) {
    el.style.display = 'block';
    el.textContent = '🎁 شاورما هدية — مجاناً (كود ' + _appliedPromo.code + ')';
  } else {
    el.style.display = 'none';
  }
}

function resetPromoState() {
  _appliedPromo = null;
  var input = document.getElementById('promoCodeInput');
  var btn   = document.getElementById('promoApplyBtn');
  var msg   = document.getElementById('promoMsg');
  if (input) { input.value = ''; input.disabled = false; }
  if (btn)   { btn.disabled = false; btn.textContent = 'تطبيق'; btn.style.display = ''; }
  if (msg)   { msg.style.display = 'none'; msg.textContent = ''; }
  renderPromoGiftLine();
}

function applyPromoCode() {
  var input = document.getElementById('promoCodeInput');
  var btn   = document.getElementById('promoApplyBtn');
  var msg   = document.getElementById('promoMsg');
  var code  = (input.value || '').trim();
  if (!code) return;

  var normPhone = normalizeSaudiPhone(document.getElementById('custPhone').value.trim());
  if (!normPhone) {
    msg.style.display = 'block'; msg.style.color = '#b91c1c';
    msg.textContent = 'اكتب رقم جوالك أولاً عشان نتحقق من الكود';
    return;
  }

  btn.disabled = true; btn.textContent = 'جاري التحقق…';
  fetch('/api/promo/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code, phone: normPhone }),
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      msg.style.display = 'block';
      if (data.valid) {
        _appliedPromo = { code: code.toUpperCase(), grocery: data.grocery || '' };
        msg.style.color = '#166534';
        msg.textContent = data.message || '🎉 تم تطبيق الكود';
        input.disabled = true;
        btn.style.display = 'none';
      } else {
        _appliedPromo = null;
        btn.disabled = false; btn.textContent = 'تطبيق';
        msg.style.color = '#b91c1c';
        msg.textContent = data.message || 'الكود غير صحيح';
      }
      renderPromoGiftLine();
    })
    .catch(function() {
      btn.disabled = false; btn.textContent = 'تطبيق';
      msg.style.display = 'block'; msg.style.color = '#b91c1c';
      msg.textContent = 'تعذّر التحقق من الكود — حاول مرة ثانية';
    });
}

// Normalize a Saudi mobile to 05XXXXXXXX, or return null if invalid
function normalizeSaudiPhone(raw) {
  var d = (raw || '').replace(/[^0-9]/g, '');
  if (/^9665\d{8}$/.test(d)) return '0' + d.slice(3);  // 9665XXXXXXXX
  if (/^5\d{8}$/.test(d))    return '0' + d;            // 5XXXXXXXX
  if (/^05\d{8}$/.test(d))   return d;                  // 05XXXXXXXX
  return null;
}

async function submitOrder(e) {
  e.preventDefault();
  var btn = document.getElementById('submitBtn');

  // Safety net: the checkout button is already disabled when closed, but block
  // here too in case the form is submitted some other way.
  if (!isStoreOpen()) {
    alert('المطعم مغلق الآن — نفتح 3 العصر 🌯. تقدر تجهّز طلبك وترسله وقت الفتح.');
    return;
  }

  var name  = document.getElementById('custName').value.trim();
  var phone = document.getElementById('custPhone').value.trim();

  // Validate before doing anything
  if (!name) {
    alert('فضلاً اكتب اسمك');
    return;
  }
  var normPhone = normalizeSaudiPhone(phone);
  if (!normPhone) {
    alert('رقم الجوال غير صحيح — اكتب رقم سعودي يبدأ بـ 05 (10 أرقام)');
    return;
  }
  phone = normPhone;

  btn.disabled    = true;
  btn.textContent = 'جاري التأكيد…';

  var items = Object.keys(cart).map(function(key) {
    return { name: cart[key].name, price: cart[key].price, qty: cart[key].qty };
  });

  var itemLines = items.map(function(it) {
    return it.qty + '× ' + it.name + ' — ' + (it.price * it.qty) + ' ريال';
  }).join('\n');
  var promoLine = _appliedPromo
    ? '\n🎁 هدية الطلب الأول: شاورما مجانية (كود ' + _appliedPromo.code + ')'
    : '';
  var grandTotal = getSubtotal() + getDeliveryFee();
  var preOrderNote = isStoreOpen() ? '' :
    '⏰ طلب قبل وقت الدوام — يُحضّر مع بداية الدوام (3 عصراً).\n\n';
  var waMsg;
  if (IS_PICKUP) {
    waMsg = 'مرحباً شاورمات 🌯، تم تجهيز طلبي من الموقع.\n'
          + '👤 ' + name + '\n'
          + '📱 ' + phone + '\n'
          + '🏪 طلب استلام من المحل\n'
          + '———————\n'
          + itemLines + promoLine + '\n'
          + 'الحساب: ' + grandTotal + ' ريال.\n\n'
          + preOrderNote
          + 'متى يكون الطلب جاهزاً للاستلام؟';
  } else {
    var hood = selectedHood || 'الزهور';
    var fee  = getDeliveryFee();
    var costLine = fee === 0
      ? 'الأصناف: ' + getSubtotal() + ' ريال\n'
        + 'التوصيل: مجاني 🎉 (خصم ' + DELIVERY + ' ريال)\n'
        + 'الإجمالي: ' + grandTotal + ' ريال\n\n'
      : 'الحساب: ' + grandTotal + ' ريال (توصيل ' + fee + ' ريال لحي ' + hood + ').\n\n';
    var locLine = _deliveryCoords
      ? '📍 موقعي: https://maps.google.com/?q=' + _deliveryCoords.lat + ',' + _deliveryCoords.lng
      : '📍 سأرسل موقعي الآن.';
    waMsg = 'مرحباً شاورمات 🌯، تم تجهيز طلبي من الموقع.\n'
          + '👤 ' + name + '\n'
          + '📱 ' + phone + '\n'
          + '———————\n'
          + itemLines + promoLine + '\n'
          + costLine
          + preOrderNote
          + locLine;
  }
  // Goes to the fulfilling branch's WhatsApp (resolved from the chosen hood,
  // or the branch picked for pickup).
  var waUrl = 'https://wa.me/' + waNumber() + '?text=' + encodeURIComponent(waMsg);

  // Open WhatsApp synchronously within the click gesture (avoids popup blocker).
  // WhatsApp is the only way to complete the order; the order is recorded now.
  window.open(waUrl, '_blank');
  _waOpened = true;

  var payload = {
    name:         name,
    phone:        phone,
    address:      document.getElementById('custAddress').value.trim(),
    note:         document.getElementById('custNote').value.trim(),
    neighborhood: selectedHood || '',
    // Only consulted server-side for pickup (no hood to derive the branch from).
    branch:       _activeBranch,
    items:        items,
    total:        grandTotal,
  };
  // Captured delivery location → store it (admin/track map) + flag if out of zone.
  if (_deliveryCoords) {
    payload.lat = _deliveryCoords.lat;
    payload.lng = _deliveryCoords.lng;
    payload.out_of_range = !!_deliveryCoords.outOfRange;
  }
  // Server re-validates this — never trust the client's earlier /api/promo/check.
  if (_appliedPromo) {
    payload.promo_code = _appliedPromo.code;
  }

  try {
    var res  = await fetch('/api/order', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    var data = await res.json();

    if (data.success) {
      gtagSafe('event', 'conversion', {
        send_to: 'AW-712124773',
        value: grandTotal,
        currency: 'SAR',
        transaction_id: String(data.order_id || ''),
      });
      gtagSafe('event', 'purchase', {
        currency: 'SAR',
        value: grandTotal,
        transaction_id: String(data.order_id || ''),
      });

      if (typeof snaptr === 'function') {
        await snapIdentify(phone);
        snaptr('track', 'PURCHASE', {
          price:          grandTotal,
          currency:       'SAR',
          transaction_id: String(data.order_id || ''),
          item_ids:       Object.keys(cart),
          number_items:   items.reduce(function(n, it) { return n + it.qty; }, 0),
        });
      }

      // Save order ID + time so the track button shows for ~3 hours then auto-hides
      try { localStorage.setItem('sw_track', JSON.stringify({ id: data.order_id, at: Date.now(), t: data.track_token || '' })); } catch(e) {}
      refreshTrackButton();
      // Save customer details for next time
      saveCustomer(name, phone, selectedHood || '', document.getElementById('custAddress').value.trim());

      closeOrderForm();
      Object.keys(cart).forEach(function(k) { delete cart[k]; });
      _deliveryCoords = null; _deliveryLocationChecked = false;   // next order captures afresh
      // Reset the delivery method to the default (delivery, 5 ريال) so the next
      // order re-confirms delivery vs pickup at checkout rather than silently
      // reusing this order's choice.
      _methodChosen = false; IS_PICKUP = false; selectedHood = null; DELIVERY = 5;
      _activeBranch = DEFAULT_BRANCH;
      resetPromoState();
      renderCart();

      // The order is recorded as a draft, but it is NOT placed until the
      // customer actually sends the WhatsApp message. Show a "last step"
      // state — success is only shown after they return from WhatsApp.
      var sTitle = document.getElementById('successTitle');
      var sIcon  = document.getElementById('successIcon');
      if (sTitle) sTitle.textContent = 'خطوة أخيرة! 📲';
      if (sIcon)  sIcon.textContent  = '📲';

      var body = '<b>طلبك ما وصلنا بعد</b> — اضغط الزر وأرسل الرسالة في واتساب عشان نستلمه ونبدأ التحضير.';
      if (!IS_PICKUP) {
        body += '<span style="font-size:.85rem;line-height:1.9;display:block;background:#f9f9f9;border-radius:8px;padding:.5rem .75rem;text-align:right;margin-top:.6rem">' +
                'وبعد الإرسال شارك موقعك: <b>(+)</b> ← <b>الموقع 📍</b> ← <b>إرسال موقعك الحالي</b> ✅' +
                '</span>';
      }
      document.getElementById('successMsg').innerHTML = body;

      var trackLink = document.getElementById('successTrackLink');
      if (trackLink) {
        trackLink.href = trackUrlFor(data.order_id);
        trackLink.style.display = 'inline-block';
      }

      // Primary CTA — send the order in WhatsApp (also covers a blocked popup)
      var waBtn = document.getElementById('successWaBtn');
      if (waBtn) {
        waBtn.href = waUrl;
        waBtn.textContent = '📲 أرسل طلبك في واتساب';
        waBtn.style.display = 'block';
        waBtn.onclick = function() { _waOpened = true; };
      }

      document.getElementById('successModal').classList.add('open');

      // Refresh loyalty after order placed
      if (phone) fetchLoyalty(phone);
    } else {
      alert('خطأ: ' + (data.error || 'حدث خطأ غير متوقع'));
    }
  } catch (err) {
    alert('خطأ في الاتصال. حاول مرة أخرى.');
  } finally {
    btn.disabled    = false;
    btn.textContent = '📲 تأكيد الطلب عبر واتساب';
  }
}

function closeSuccess() {
  document.getElementById('successModal').classList.remove('open');
}

// ── Save / load customer details ──────────────

function saveCustomer(name, phone, neighborhood, address) {
  try {
    localStorage.setItem('sw_customer', JSON.stringify({
      name:         name,
      phone:        phone,
      neighborhood: neighborhood,
      address:      address,
    }));
  } catch (e) {}
}

function getSavedCustomer() {
  try {
    var raw = localStorage.getItem('sw_customer');
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

// ── Chip initialization ────────────────────────

document.addEventListener('DOMContentLoaded', function() {
  // Open/closed status — refresh every minute so it flips at open/close time
  updateOpenStatus();
  setInterval(updateOpenStatus, 60 * 1000);

  // Rotating hero meal photo (landing screen)
  initHeroSolo();

  // شيفو speech bubble
  initChatBubble();

  // iOS: show add-to-home-screen hint after a short delay
  setTimeout(showIosHintIfNeeded, 2500);

  refreshTrackButton();

  // Load loyalty if phone saved
  var saved = getSavedCustomer();
  if (saved && saved.phone) {
    fetchLoyalty(saved.phone);
  }
  // Attach whatever identity we have before the funnel starts, so ADD_CART and
  // START_CHECKOUT are matchable too and not just PURCHASE. Deferred a moment
  // because scevent.min.js loads async and has to set `_scid` first.
  setTimeout(function() { snapIdentify(saved && saved.phone); }, 1500);

  // Chip groups that update a price display element
  [
    ['fries-size',        'fries-price'],
    ['sauce-type',        'sauce-price'],
    ['broasted-meal-size','broasted-meal-price'],
    ['broasted-size',     'broasted-price'],
    ['plate-size',        'plate-price'],
  ].forEach(function(pair) {
    var g = document.getElementById(pair[0]);
    if (!g) return;
    g.querySelectorAll('.chip').forEach(function(chip) {
      chip.addEventListener('click', function() {
        g.querySelectorAll('.chip').forEach(function(c) { c.classList.remove('active'); });
        chip.classList.add('active');
        var el = document.getElementById(pair[1]);
        if (el) el.textContent = chip.dataset.price + ' ريال';
      });
    });
  });

  // Shawarma sandwich: flavor chips update price display
  var swf = document.getElementById('sw-flavor');
  if (swf) {
    swf.querySelectorAll('.chip').forEach(function(chip) {
      chip.addEventListener('click', function() {
        swf.querySelectorAll('.chip').forEach(function(c) { c.classList.remove('active'); });
        chip.classList.add('active');
        updateSwPrice();
      });
    });
  }

  // Fixed-price items with flavor choice: "مشكل" adds surcharge to displayed price
  [
    ['rok-flavor',        'rok-price',         13],
    ['jmb-flavor',        'jmb-price',         13],
    ['rocket-meal-flavor','rocket-meal-price', 19],
    ['jumbo-meal-flavor', 'jumbo-meal-price',  19],
  ].forEach(function(row) {
    var g = document.getElementById(row[0]);
    if (!g) return;
    g.querySelectorAll('.chip').forEach(function(chip) {
      chip.addEventListener('click', function() {
        g.querySelectorAll('.chip').forEach(function(c) { c.classList.remove('active'); });
        chip.classList.add('active');
        var el = document.getElementById(row[1]);
        if (el) el.textContent = (row[2] + (chip.dataset.val === 'مشكل' ? MIXED_SURCHARGE : 0)) + ' ريال';
      });
    });
  });

  // Sized meals with flavor choice: "مشكل" adds surcharge per sandwich
  [
    ['sw-meal-size',     'sw-meal-flavor',     'sw-meal-price'],
    ['family-meal-size', 'family-meal-flavor', 'family-meal-price'],
    ['arabic-sw-size',   'arabic-sw-flavor',   'arabic-sw-price'],
    ['arabic-meal-size', 'arabic-meal-flavor', 'arabic-meal-price'],
  ].forEach(function(row) {
    var sizeG   = document.getElementById(row[0]);
    var flavorG = document.getElementById(row[1]);
    if (!sizeG || !flavorG) return;
    function recalc() {
      var sizeChip = sizeG.querySelector('.chip.active');
      if (!sizeChip) return;
      var price = parseInt(sizeChip.dataset.price);
      if (isMixedSelected(row[1])) price += MIXED_SURCHARGE * parseInt(sizeChip.dataset.count || '1');
      var el = document.getElementById(row[2]);
      if (el) el.textContent = price + ' ريال';
    }
    [sizeG, flavorG].forEach(function(g) {
      g.querySelectorAll('.chip').forEach(function(chip) {
        chip.addEventListener('click', function() {
          g.querySelectorAll('.chip').forEach(function(c) { c.classList.remove('active'); });
          chip.classList.add('active');
          recalc();
        });
      });
    });
  });

  // Click-only chip groups (no price change)
  ['broasted-type', 'drink-flavor'].forEach(function(gId) {
    var g = document.getElementById(gId);
    if (!g) return;
    g.querySelectorAll('.chip').forEach(function(chip) {
      chip.addEventListener('click', function() {
        g.querySelectorAll('.chip').forEach(function(c) { c.classList.remove('active'); });
        chip.classList.add('active');
      });
    });
  });

  // Dynamic image swap when chip changes
  [
    ['drink-flavor',     'drink-img'],
    ['arabic-sw-size',   'arabic-sw-img'],
    ['arabic-meal-size', 'arabic-meal-img'],
    ['sw-meal-size',     'sw-meal-img'],
    ['family-meal-size', 'family-meal-img'],
  ].forEach(function(pair) {
    var g   = document.getElementById(pair[0]);
    var img = document.getElementById(pair[1]);
    if (!g || !img) return;
    g.querySelectorAll('.chip').forEach(function(chip) {
      chip.addEventListener('click', function() {
        if (chip.dataset.img) {
          img.src = '/static/images/' + chip.dataset.img + '.webp';
        }
      });
    });
  });

  // Fetch loyalty when phone field is filled
  var phoneField = document.getElementById('custPhone');
  if (phoneField) {
    phoneField.addEventListener('blur', function() {
      var ph = phoneField.value.trim();
      if (ph.length >= 9) fetchLoyalty(ph);
    });
  }

  // Init chatbot
  initChatbot();
});

// ════════════════════════════════════════════
//  PWA — install prompt + service worker
// ════════════════════════════════════════════

if ('serviceWorker' in navigator) {
  window.addEventListener('load', function() {
    navigator.serviceWorker.register('/sw.js').catch(function() {});
  });
}

var _deferredInstall = null;

window.addEventListener('beforeinstallprompt', function(e) {
  e.preventDefault();
  _deferredInstall = e;
  var btn = document.getElementById('installBtn');
  if (btn) btn.style.display = 'inline-flex';
});

function promptInstall() {
  if (!_deferredInstall) return;
  _deferredInstall.prompt();
  _deferredInstall = null;
  var btn = document.getElementById('installBtn');
  if (btn) btn.style.display = 'none';
}

window.addEventListener('appinstalled', function() {
  var btn = document.getElementById('installBtn');
  if (btn) btn.style.display = 'none';
});

// After the customer goes to WhatsApp and returns, hide the re-send button
// so they don't accidentally fire the same order again.
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible' && _waOpened) {
    _waOpened = false;
    var waBtn = document.getElementById('successWaBtn');
    if (waBtn) waBtn.style.display = 'none';
    var sTitle = document.getElementById('successTitle');
    var sIcon  = document.getElementById('successIcon');
    if (sTitle) sTitle.textContent = 'وصلنا طلبك! ✅';
    if (sIcon)  sIcon.textContent  = '✅';
    var msg = document.getElementById('successMsg');
    if (msg) msg.innerHTML = IS_PICKUP
      ? 'بنجهّزه للاستلام 🌯 — تقدر تتابع حالته من زر تتبع الطلب.'
      : 'بنجهّزه فوراً 🌯 — تأكد إنك أرسلت موقعك في واتساب.';
  }
});

// iOS Safari has no install prompt — show a one-time how-to banner instead
function isIosDevice() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function isStandaloneApp() {
  return window.matchMedia('(display-mode: standalone)').matches ||
         navigator.standalone === true;
}

function showIosHintIfNeeded() {
  if (!isIosDevice() || isStandaloneApp()) return;
  try {
    if (localStorage.getItem('sw_ios_hint_dismissed')) return;
  } catch (e) {}
  var banner = document.getElementById('iosInstallBanner');
  if (banner) banner.style.display = 'flex';
}

function dismissIosHint() {
  var banner = document.getElementById('iosInstallBanner');
  if (banner) banner.style.display = 'none';
  try { localStorage.setItem('sw_ios_hint_dismissed', '1'); } catch (e) {}
}

// ════════════════════════════════════════════
//  CHATBOT
// ════════════════════════════════════════════

var chatOpen = false;
var _chatHistory = [];

// ── شيفو speech bubble ────────────────────────
// Draws the eye without sound: browsers block autoplay audio without a prior
// user gesture anyway (so a "notification sound" on page load would just be
// silent for every first-time — i.e. ad-traffic — visitor). A visual bubble
// has no such restriction. Cycles a few inviting lines, in شيفو's own voice;
// stops for good once the customer notices him (opens chat) or dismisses it.
var CHAT_BUBBLE_LINES = [
  'جوعان؟ اسألني! 🌯',
  'أبشر، أساعدك تختار وجبتك 👨‍🍳',
  'جرّب وجبة اليوم 😋',
  'عندك سؤال عن المنيو؟ تفضل',
];
var _chatBubbleTimer = null;
var _chatBubbleLine = 0;
var _chatBubbleStopped = false;

function showChatBubble() {
  if (_chatBubbleStopped || chatOpen) return;
  var el = document.getElementById('chatBubble');
  var txt = document.getElementById('chatBubbleText');
  if (!el || !txt) return;
  txt.textContent = CHAT_BUBBLE_LINES[_chatBubbleLine % CHAT_BUBBLE_LINES.length];
  _chatBubbleLine++;
  el.classList.add('show');
  _chatBubbleTimer = setTimeout(function() {
    el.classList.remove('show');
    // Come back later and say something else, until dismissed or noticed.
    _chatBubbleTimer = setTimeout(showChatBubble, 25000);
  }, 6000);
}

// Pauses the cycle (chat opened) without marking it dismissed — harmless
// either way since toggleChat only calls this while closing the panel back up.
function stopChatBubble() {
  if (_chatBubbleTimer) { clearTimeout(_chatBubbleTimer); _chatBubbleTimer = null; }
  var el = document.getElementById('chatBubble');
  if (el) el.classList.remove('show');
}

// Explicit customer dismissal (✕) — stop for the rest of this visit.
function dismissChatBubble() {
  _chatBubbleStopped = true;
  stopChatBubble();
}

function initChatBubble() {
  if (!document.getElementById('chatBubble')) return;
  _chatBubbleTimer = setTimeout(showChatBubble, 2500);
}

function toggleChat() {
  chatOpen = !chatOpen;
  var panel = document.getElementById('chatPanel');
  if (chatOpen) {
    stopChatBubble();   // he's been noticed — stop talking to himself
    panel.classList.add('open');
    document.getElementById('chatInput').focus();
    // Show welcome if first time
    if (!window._chatInited) {
      window._chatInited = true;
      addBotMsg('أهلين! 🤖 أنا شيفو، مساعد شاورمات. وش تشتهي اليوم؟ 🌯');
      renderQuickReplies([
        'أوقات العمل',
        'أسعار الشاورما',
        'رسوم التوصيل',
        'طرق الدفع',
        'كلمني',
      ]);
    }
  } else {
    panel.classList.remove('open');
  }
}

function closeChat() {
  chatOpen = false;
  document.getElementById('chatPanel').classList.remove('open');
}

// Keep the "كلّم شيفو" FAB from covering the checkout CTA: hide it (and close
// the chat panel) whenever the cart drawer or any modal/upsell is open.
function updateChatFabVisibility() {
  var fab = document.getElementById('chatFab');
  if (!fab) return;
  var cart = document.getElementById('cartSidebar');
  var cartOpen  = !!(cart && cart.classList.contains('open'));
  var modalOpen = !!document.querySelector('.modal-overlay.open');
  var block = cartOpen || modalOpen;
  fab.style.display = block ? 'none' : '';
  if (block && chatOpen) closeChat();
}

document.addEventListener('DOMContentLoaded', function () {
  var targets = [document.getElementById('cartSidebar')]
    .concat(Array.prototype.slice.call(document.querySelectorAll('.modal-overlay')));
  var obs = new MutationObserver(updateChatFabVisibility);
  targets.forEach(function (el) { if (el) obs.observe(el, { attributes: true, attributeFilter: ['class'] }); });
  updateChatFabVisibility();
});

function addBotMsg(text) {
  addChatMsg(text, 'bot');
}

function addUserMsg(text) {
  addChatMsg(text, 'user');
}

var SHAIFU_AVATAR = '/static/images/shaifu.svg';

function makeAvatar() {
  var av = document.createElement('img');
  av.className = 'chat-avatar';
  av.src = SHAIFU_AVATAR;
  av.alt = 'شيفو';
  return av;
}

function escapeHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Turn any phone number or wa.me link in a bot reply into a clickable WhatsApp
// link. Always points to the correct number, even if the bot mistyped digits.
function linkifyBot(text) {
  var safe = escapeHtml(text);
  // Render basic **bold** and strip any leftover markdown asterisks
  safe = safe.replace(/\*\*([^*]+?)\*\*/g, '<b>$1</b>').replace(/\*\*/g, '');
  var re = /(?:https?:\/\/)?wa\.me\/\d+|\+?\d[\d\s-]{7,14}\d/g;
  return safe.replace(re, function(m) {
    var isWa   = /wa\.me/.test(m);
    var digits = m.replace(/\D/g, '');
    if (!isWa && (digits.length < 9 || digits.length > 13)) return m;  // not a phone
    return '<a href="https://wa.me/' + waNumber() + '" target="_blank" ' +
           'style="color:#d32027;font-weight:700;text-decoration:underline">' +
           '📱 ' + waDisplay() + '</a>';
  });
}

function addChatMsg(text, role) {
  var msgs = document.getElementById('chatMessages');
  if (role === 'bot') {
    var row = document.createElement('div');
    row.className = 'chat-row bot';
    var bubble = document.createElement('div');
    bubble.className = 'chat-msg bot';
    bubble.innerHTML = linkifyBot(text);
    row.appendChild(makeAvatar());
    row.appendChild(bubble);
    msgs.appendChild(row);
  } else {
    var div = document.createElement('div');
    div.className = 'chat-msg ' + role;
    div.textContent = text;
    msgs.appendChild(div);
  }
  msgs.scrollTop = msgs.scrollHeight;
}

function renderQuickReplies(chips) {
  var qr = document.getElementById('chatQuickReplies');
  qr.innerHTML = '';
  chips.forEach(function(label) {
    var btn = document.createElement('button');
    btn.className = 'chat-qr-btn';
    btn.textContent = label;
    btn.onclick = function() {
      qr.innerHTML = '';
      handleChatInput(label);
    };
    qr.appendChild(btn);
  });
}

function sendChatMessage() {
  var input = document.getElementById('chatInput');
  var text  = input.value.trim();
  if (!text) return;
  input.value = '';
  handleChatInput(text);
}

function showTypingIndicator() {
  var msgs = document.getElementById('chatMessages');
  var row = document.createElement('div');
  row.className = 'chat-row bot';
  row.id = 'typingDots';
  var bubble = document.createElement('div');
  bubble.className = 'chat-msg bot typing-indicator';
  bubble.innerHTML = '<span></span><span></span><span></span>';
  row.appendChild(makeAvatar());
  row.appendChild(bubble);
  msgs.appendChild(row);
  msgs.scrollTop = msgs.scrollHeight;
}

function removeTypingIndicator() {
  var el = document.getElementById('typingDots');
  if (el) el.remove();
}

async function handleChatInput(text) {
  addUserMsg(text);
  document.getElementById('chatQuickReplies').innerHTML = '';
  showTypingIndicator();

  try {
    var res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, history: _chatHistory }),
    });
    var data = await res.json();
    var reply = data.reply || 'عذراً، حدث خطأ. تواصل معنا على واتساب 📱';
    removeTypingIndicator();
    addBotMsg(reply);
    _chatHistory.push({ role: 'user', content: text });
    _chatHistory.push({ role: 'assistant', content: reply });
    if (_chatHistory.length > 12) _chatHistory = _chatHistory.slice(-12);
    renderQuickReplies(['أسعار الشاورما', 'أوقات العمل', 'رسوم التوصيل', 'كلمني']);
  } catch (e) {
    removeTypingIndicator();
    addBotMsg('تحقق من الاتصال، أو تواصل معنا على واتساب 📱');
    renderQuickReplies(['كلمني']);
  }
}

// Legacy — kept for reference only, no longer called
function getChatReply(text) {
  var t = text.toLowerCase();
  var menuData   = window.MENU_DATA   || {};
  var hoodFees   = window.NEIGHBORHOOD_FEES || {};

  // Hours
  if (/وقت|ساعة|ساعات|يفتح|يغلق|العمل|متى/.test(t)) {
    return {
      text: 'نعمل يومياً من الساعة 3 عصراً حتى 2 صباحاً.',
      chips: ['أسعار الشاورما', 'رسوم التوصيل', 'طرق الدفع'],
    };
  }

  // Delivery zones & fees
  if (/توصيل|أحياء|حي|منطقة|رسوم|تكلفة التوصيل/.test(t)) {
    var feeLines = Object.entries(hoodFees).map(function(kv) {
      return kv[0] + ': ' + kv[1] + ' ريال';
    }).join(' | ');
    return {
      text: 'نوصّل للأحياء التالية:\n' + feeLines,
      chips: ['أوقات العمل', 'أسعار الشاورما', 'كلمني'],
    };
  }

  // Payment
  if (/دفع|كاش|نقد|بطاقة|تحويل|سداد/.test(t)) {
    return {
      text: 'الدفع نقداً عند الاستلام فقط حالياً.',
      chips: ['أوقات العمل', 'رسوم التوصيل', 'كلمني'],
    };
  }

  // Allergens
  if (/حساسية|الرجين|مكونات|مواد|gluten|لاكتوز/.test(t)) {
    return {
      text: 'لمعلومات عن المكوّنات والحساسية الغذائية، تواصل معنا مباشرة عبر واتساب.',
      chips: ['كلمني'],
    };
  }

  // Prices — shawarma
  if (/سعر|أسعار|كم|تكلف|شاورما/.test(t)) {
    var items = (menuData.shawarma || []).slice(0, 6);
    var lines = items.map(function(i) { return i.name + ': ' + i.price + ' ريال'; }).join(' | ');
    return {
      text: 'أسعار الشاورما:\n' + (lines || 'شاورما ساندويش: 7-13 ريال، شاورما وسط: 10 ريال، جامبو: 13 ريال، صاروخ: 13 ريال') ,
      chips: ['أسعار الوجبات', 'رسوم التوصيل', 'أوقات العمل'],
    };
  }

  // Prices — meals (fixed combo: shawarma + fries + Pepsi; price by piece count)
  if (/وجبة|وجبات/.test(t)) {
    return {
      text: 'الوجبة = شاورما + بطاطس + بيبسي، والسعر حسب عدد الشاورما:\n' +
            '• شاورما واحدة: 14 ريال\n' +
            '• شاورمتين: 20 ريال\n' +
            '• ثلاث شاورما: 26 ريال\n' +
            'وجبة صاروخ/جامبو: 19 ريال · نكهة مشكل تضيف 1 ريال لكل شاورما 🌯',
      chips: ['أسعار الشاورما', 'رسوم التوصيل', 'كلمني'],
    };
  }

  // Drinks
  if (/مشروب|بيبسي|عصير|ماء/.test(t)) {
    return {
      text: 'المشروبات الغازية (بيبسي، بيبسي زيرو، ميرندا، سفن أب، سفن أب زيرو): 4 ريال\nماء معدني: 1 ريال',
      chips: ['أسعار الشاورما', 'أسعار الوجبات', 'كلمني'],
    };
  }

  // Talk to us
  if (/كلمني|واتساب|تواصل|اتصل/.test(t)) {
    window.open('https://wa.me/' + waNumber(), '_blank');
    return {
      text: 'تم فتح واتساب! يسعدنا مساعدتك.',
      chips: ['أوقات العمل', 'أسعار الشاورما'],
    };
  }

  // Greeting
  if (/أهلاً|مرحبا|السلام|هلا|hi|hello/.test(t)) {
    return {
      text: 'أهلاً بك! كيف أقدر أساعدك؟',
      chips: ['أوقات العمل', 'أسعار الشاورما', 'رسوم التوصيل', 'طرق الدفع', 'كلمني'],
    };
  }

  // Fallback
  return {
    text: 'للأسف ما فهمت سؤالك. يمكنك التواصل معنا مباشرة عبر واتساب.',
    chips: ['كلمني', 'أوقات العمل', 'رسوم التوصيل'],
  };
}

function initChatbot() {
  var input = document.getElementById('chatInput');
  if (!input) return;
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') sendChatMessage();
  });
}
