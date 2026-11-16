/**
 * Slerp order-event receiver (Google Apps Script web app).
 *
 * Slerp Controls -> Integrations -> "Connect your own tools" sends every order
 * event (order.created, order.status_updated, order.delivery_status_updated,
 * order.pickup_status_updated) to each registered URL. Two such webhooks
 * already exist on the account (both Apps Script URLs owned elsewhere); this
 * is a third, owned by Ross, so the ops pipeline has its own feed. It appends
 * one row per event to a Google Sheet, which maki-hospitality-etl reads
 * nightly as the feed "Slerp Order Events" (slerp_orders.py).
 *
 * Payload reference: https://support.slerp.com/knowledge/slerp-order-webhook-payload-reference
 *   - envelope: id (event UUID), type, createdAt, data.order
 *   - order id is `reference` (e.g. UGE6HT); store = {id, name}
 *   - money fields are decimal strings {base, discounted}; use summary.total
 *   - Slerp waits 30 s; any 2xx acknowledges; 400 counts as a FAILURE and 20
 *     consecutive failures switch the webhook off. So this ALWAYS returns 200,
 *     even for junk, and logs the junk instead.
 *
 * PRIVACY: customerDetails, recipientDetails and deliveryAddress are dropped
 * before anything is written. The ops warehouse needs sites, times, status,
 * items and money - not names, phones or addresses.
 *
 * SET-UP (Ross, once):
 *   1. Create a Google Sheet named "Slerp Order Events (ETL)". Rename its tab
 *      to "events". Note the sheet id from the URL.
 *   2. script.google.com -> New project -> paste this file. Project Settings
 *      -> Script Properties:
 *        SHEET_ID  = <that sheet id>
 *        TOKEN     = <a long random string; the URL query ?token=... must match>
 *   3. Deploy -> New deployment -> Web app: Execute as "Me", Who has access
 *      "Anyone". Copy the /exec URL.
 *   4. Slerp Controls -> Integrations -> Connect your own tools -> Add:
 *      name "Ops warehouse", URL = <exec URL>?token=<TOKEN>.
 *   5. Share the sheet (Viewer) with the ETL service account - the address in
 *      the GOOGLE_SA_JSON secret (client_email) - and set the GitHub secret
 *      SLERP_SHEET_ID on maki-hospitality-etl to the sheet id.
 *   6. Place a test order or wait for the next real one; a row appears within
 *      seconds. The feed lands on the next Daily Hospitality Export.
 */

const HEADER = [
  'received_at', 'event_id', 'event_type', 'event_created_at',
  'reference', 'order_status', 'order_created_at', 'order_updated_at',
  'store_id', 'store_name',
  'fulfillment_type', 'order_type', 'fulfillment_status', 'window_start', 'window_end',
  'assigned_pickup_time', 'delivered_at',
  'customer_type', 'item_count', 'item_quantity',
  'subtotal_base', 'subtotal_discounted', 'delivery_base', 'delivery_discounted',
  'store_fee_base', 'store_fee_discounted', 'store_fee_name', 'tip',
  'total_base', 'total_discounted',
  'order_notes', 'items_json', 'raw_json',
];

function doPost(e) {
  const props = PropertiesService.getScriptProperties();
  const expected = props.getProperty('TOKEN');
  const given = (e && e.parameter && e.parameter.token) || '';
  if (!expected || given !== expected) {
    console.warn('rejected: bad token');
    return ok_({ ok: false, reason: 'bad token' });   // still 200: never trip Slerp's failure counter
  }
  let body;
  try {
    body = JSON.parse((e.postData && e.postData.contents) || '{}');
  } catch (err) {
    console.warn('rejected: not JSON: ' + err);
    return ok_({ ok: false, reason: 'not json' });
  }
  const order = (body.data && body.data.order) || {};
  if (!body.id || !body.type || !order.reference) {
    console.warn('ignored: missing id/type/order.reference: ' + JSON.stringify(body).slice(0, 300));
    return ok_({ ok: false, reason: 'not an order event' });
  }

  // Dedupe retries of the same event id (Slerp retries on timeouts/5xx).
  const cache = CacheService.getScriptCache();
  if (cache.get('evt:' + body.id)) return ok_({ ok: true, duplicate: true });

  const row = rowFor_(body, order);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = sheet_(props.getProperty('SHEET_ID'));
    sheet.appendRow(row);
  } finally {
    lock.releaseLock();
  }
  cache.put('evt:' + body.id, '1', 21600);   // 6 h, the longest Slerp retry horizon
  return ok_({ ok: true });
}

function doGet() {
  return ok_({ ok: true, note: 'Slerp order-event receiver; POST only' });
}

function rowFor_(body, order) {
  const f = order.fulfillment || {};
  const d = order.delivery || {};
  const s = order.summary || {};
  const st = order.store || {};
  const items = Array.isArray(order.orderItems) ? order.orderItems : [];
  const qty = items.reduce((n, it) => n + (Number(it.quantity) || 0), 0);
  const money = (o, k) => (o && o[k] != null) ? String(o[k]) : '';
  // Strip personal data before keeping the raw payload.
  const raw = JSON.parse(JSON.stringify(body));
  if (raw.data && raw.data.order) {
    delete raw.data.order.customerDetails;
    delete raw.data.order.recipientDetails;
    delete raw.data.order.deliveryAddress;
    if (raw.data.order.delivery) delete raw.data.order.delivery.instructions;
  }
  const slimItems = items.map(it => ({
    name: it.name, sku: it.product && it.product.sku, quantity: it.quantity,
    base: money(it.total, 'base'), discounted: money(it.total, 'discounted'),
    modifiers: (it.modifierGroups || []).flatMap(g => (g.modifiers || []).map(m => ({
      group: g.name, name: m.name, sku: m.sku, quantity: m.quantity,
      base: money(m.price, 'base'), discounted: money(m.price, 'discounted'),
    }))),
  }));
  return [
    new Date().toISOString(), body.id, body.type, body.createdAt || '',
    order.reference, order.status || '', order.createdAt || '', order.updatedAt || '',
    st.id || '', st.name || '',
    f.type || '', f.orderType || '', f.status || '', f.windowStart || '', f.windowEnd || '',
    d.assignedPickupTime || '', d.deliveredAt || '',
    (order.customerDetails && order.customerDetails.type) || '', items.length, qty,
    money(s.subtotal, 'base'), money(s.subtotal, 'discounted'),
    money(s.delivery, 'base'), money(s.delivery, 'discounted'),
    money(s.storeFee, 'base'), money(s.storeFee, 'discounted'), s.storeFeeName || '',
    s.tip != null ? String(s.tip) : '',
    money(s.total, 'base'), money(s.total, 'discounted'),
    order.orderNotes || '', JSON.stringify(slimItems), JSON.stringify(raw),
  ];
}

function sheet_(sheetId) {
  if (!sheetId) throw new Error('Script Property SHEET_ID is not set');
  const ss = SpreadsheetApp.openById(sheetId);
  let sh = ss.getSheetByName('events');
  if (!sh) sh = ss.insertSheet('events');
  if (sh.getLastRow() === 0) sh.appendRow(HEADER);
  return sh;
}

function ok_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Run once from the editor to confirm the sheet and token are wired. */
function selfTest() {
  const sample = {
    id: 'selftest-' + Date.now(), type: 'order.created', createdAt: new Date().toISOString(),
    data: { order: { reference: 'SELFTEST', status: 'PENDING', createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), store: { id: '00000000-0000-0000-0000-000000000000', name: 'Self test' },
      fulfillment: { type: 'PICKUP', orderType: 'SAMEDAY_ASAP', status: 'PENDING', windowStart: new Date().toISOString(), windowEnd: null },
      customerDetails: { type: 'GUEST', firstName: 'x', lastName: 'y', email: 'x@y', contactNumber: '+440000000000' },
      orderItems: [{ name: 'Test ramen', quantity: 1, product: { name: 'Test ramen', sku: 'TEST' }, total: { base: '1.00', discounted: '1.00' }, modifierGroups: [] }],
      summary: { subtotal: { base: '1.00', discounted: '1.00' }, delivery: null, storeFee: null, storeFeeName: null, tip: null, total: { base: '1.00', discounted: '1.00' } },
      additionalItems: {} } },
  };
  const props = PropertiesService.getScriptProperties();
  const res = doPost({ parameter: { token: props.getProperty('TOKEN') }, postData: { contents: JSON.stringify(sample) } });
  console.log(res.getContent());
}
