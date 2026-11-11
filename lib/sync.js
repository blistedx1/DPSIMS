/**
 * Shared multi-device state merge & notification diff helpers
 * Used by both server.js (local/LAN) and api/data.js (Vercel serverless).
 */

function stripMeta(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const copy = Object.assign({}, obj);
  delete copy._op;
  delete copy._reset;
  return copy;
}

function mergeAuthRec(a, b) {
  if (!a) return b ? Object.assign({}, b) : null;
  if (!b) return Object.assign({}, a);
  const ta = Math.max(Number(a.updatedAt || 0), Number(a.resetAt || 0));
  const tb = Math.max(Number(b.updatedAt || 0), Number(b.resetAt || 0));
  if (tb > ta) return Object.assign({}, b);
  if (ta > tb) return Object.assign({}, a);
  const ca = !!(a.changed || a.pinChanged);
  const cb = !!(b.changed || b.pinChanged);
  if (cb && !ca) return Object.assign({}, b);
  if (ca && !cb) return Object.assign({}, a);
  return Object.assign({}, b);
}

function mergeAuthState(existingAuth, incomingAuth) {
  const ea = existingAuth && typeof existingAuth === 'object' ? existingAuth : {};
  const ia = incomingAuth && typeof incomingAuth === 'object' ? incomingAuth : {};
  const out = {};
  if (ea.admin || ia.admin) out.admin = mergeAuthRec(ea.admin, ia.admin);
  if (ea.principal || ia.principal) out.principal = mergeAuthRec(ea.principal, ia.principal);
  const et = ea.teachers && typeof ea.teachers === 'object' ? ea.teachers : {};
  const it = ia.teachers && typeof ia.teachers === 'object' ? ia.teachers : {};
  const tNames = new Set([...Object.keys(et), ...Object.keys(it)]);
  out.teachers = {};
  for (const name of tNames) {
    out.teachers[name] = mergeAuthRec(et[name], it[name]);
  }
  return out;
}

function mergePrefs(existingPrefs, incomingPrefs) {
  const ep = existingPrefs && typeof existingPrefs === 'object' ? existingPrefs : {};
  const ip = incomingPrefs && typeof incomingPrefs === 'object' ? incomingPrefs : {};
  const merged = Object.assign({}, ep, ip);
  const a = Array.isArray(ep.seenReqIds) ? ep.seenReqIds.map(String) : [];
  const b = Array.isArray(ip.seenReqIds) ? ip.seenReqIds.map(String) : [];
  if (a.length || b.length) {
    merged.seenReqIds = Array.from(new Set([...a, ...b]));
  }
  return merged;
}

function cloneItemsAndLog(existing) {
  const base = stripMeta(existing);
  base.items = Array.isArray(base.items)
    ? base.items.map(it => Object.assign({}, it, { v: Array.isArray(it.v) ? it.v.map(x => x.slice()) : [] }))
    : [];
  base.log = Array.isArray(base.log) ? base.log.slice() : [];
  return base;
}

function applyStockDelta(items, id, variantName, delta) {
  const item = items.find(it => it && Number(it.id) === Number(id));
  if (!item || !Array.isArray(item.v)) return false;
  const vr = item.v.find(x => x && x[0] === variantName);
  if (!vr) return false;
  const next = Number(vr[1] || 0) + delta;
  if (delta < 0 && next < 0) return false;
  vr[1] = Math.max(0, next);
  return true;
}

function mergeAppState(existing, incoming) {
  const cleanIncoming = stripMeta(incoming);
  if (!cleanIncoming || typeof cleanIncoming !== 'object') {
    return { state: existing || { items: [], reqs: [] } };
  }

  // Explicit reset wipes cleanly
  if (incoming._reset === true) {
    cleanIncoming.updatedAt = Date.now();
    return { state: cleanIncoming };
  }

  const op = incoming._op;

  // 0. Credential update (PIN/password change or Admin reset) — never overwrite stock/reqs
  if (op && op.type === 'auth_update' && op.role && op.rec) {
    const base = stripMeta(existing || { items: [], reqs: [] });
    base.auth = mergeAuthState(base.auth, null);
    if (op.role === 'admin' || op.role === 'principal') {
      base.auth[op.role] = mergeAuthRec(base.auth[op.role], op.rec);
    } else if (op.role === 'teacher' && op.name) {
      base.auth.teachers[op.name] = mergeAuthRec(base.auth.teachers[op.name], op.rec);
    }
    base.updatedAt = Date.now();
    return { state: base };
  }

  // 0b. Delete teacher credential
  if (op && op.type === 'auth_delete_teacher' && op.name) {
    const base = stripMeta(existing || { items: [], reqs: [] });
    base.auth = mergeAuthState(base.auth, null);
    if (base.auth.teachers) delete base.auth.teachers[op.name];
    if (Array.isArray(base.fac)) base.fac = base.fac.filter(n => n !== op.name);
    base.updatedAt = Date.now();
    return { state: base };
  }

  // 0c. Teacher cart update (stored in Neon DB per teacher, zero localStorage)
  if (op && op.type === 'cart_update' && op.name) {
    const base = stripMeta(existing || { items: [], reqs: [] });
    base.carts = (base.carts && typeof base.carts === 'object') ? Object.assign({}, base.carts) : {};
    base.carts[op.name] = Array.isArray(op.cart) ? op.cart : [];
    base.updatedAt = Date.now();
    return { state: base };
  }

  // 0d. UI prefs / devlock metadata update (stored in Neon DB, zero localStorage)
  if (op && op.type === 'prefs_update' && op.prefs) {
    const base = stripMeta(existing || { items: [], reqs: [] });
    base.prefs = mergePrefs(base.prefs, op.prefs);
    base.updatedAt = Date.now();
    return { state: base };
  }
  if (op && op.type === 'devlock_update' && op.devlock) {
    const base = stripMeta(existing || { items: [], reqs: [] });
    base.devlock = Object.assign({}, base.devlock || {}, op.devlock);
    base.updatedAt = Date.now();
    return { state: base };
  }

  const hasExisting = existing && Array.isArray(existing.items) && existing.items.length > 0;
  if (!hasExisting) {
    if (existing && existing.auth) {
      cleanIncoming.auth = mergeAuthState(existing.auth, cleanIncoming.auth);
    }
    cleanIncoming.updatedAt = Date.now();
    return { state: cleanIncoming };
  }

  // 1. Teacher submits a new requisition slip: append onto latest server state with collision-free ID
  if (op && op.type === 'req_add' && op.req) {
    const base = stripMeta(existing);
    base.reqs = Array.isArray(base.reqs) ? base.reqs.slice() : [];
    const maxId = base.reqs.reduce((m, r) => Math.max(m, (r && Number(r.id)) || 0), 0);
    const newReq = Object.assign({}, op.req);
    newReq.id = maxId + 1;
    base.reqs.unshift(newReq);
    base.updatedAt = Date.now();
    return { state: base, assignedId: newReq.id };
  }

  // 2. Principal verifies/declines or Admin issues/declines a specific slip
  if (op && op.type === 'req_status' && op.req && op.id != null) {
    const base = cloneItemsAndLog(existing);
    base.reqs = Array.isArray(base.reqs) ? base.reqs.slice() : [];

    const targetId = Number(op.id);
    const idx = base.reqs.findIndex(r => r && Number(r.id) === targetId);
    const alreadyApproved = idx >= 0 && base.reqs[idx].st === 'Approved';

    if (idx >= 0) {
      base.reqs[idx] = op.req;
    } else {
      base.reqs.unshift(op.req);
    }

    // Apply stock deductions safely on server's latest items if transitioning to Approved
    if (!alreadyApproved && op.req.st === 'Approved' && Array.isArray(op.deduct)) {
      for (const d of op.deduct) {
        if (!d || d.q <= 0) continue;
        applyStockDelta(base.items, d.id, d.v, -Number(d.q));
        base.log.unshift({
          d: d.date || op.req.iDate || '',
          id: Number(d.id),
          t: 'out',
          q: Number(d.q),
          by: d.by || op.req.by || '',
          v: d.v || '',
          rem: d.rem || ''
        });
      }
      if (base.log.length > 600) base.log.length = 600;
    }

    base.updatedAt = Date.now();
    return { state: base };
  }

  // 2b. Granular Admin inventory/faculty/bill ops (never overwrite concurrent changes from other devices)
  if (op && op.type === 'item_add' && op.item && op.item.name) {
    const base = cloneItemsAndLog(existing);
    const nm = String(op.item.name).trim().toLowerCase();
    if (!base.items.some(it => it && String(it.name || '').trim().toLowerCase() === nm)) {
      const maxUid = Math.max(Number(base.uid || 0), ...base.items.map(it => Number(it && it.id) || 0));
      const newItem = Object.assign({}, op.item, { id: maxUid + 1 });
      base.uid = maxUid + 1;
      base.items.push(newItem);
    }
    base.updatedAt = Date.now();
    return { state: base };
  }

  if (op && op.type === 'stock_adj' && op.id != null && op.v && op.q > 0) {
    const base = cloneItemsAndLog(existing);
    const kind = op.kind === 'in' ? 'in' : (op.kind === 'dmg' ? 'dmg' : 'out');
    const q = Math.max(0, Math.floor(Number(op.q) || 0));
    if (q > 0 && applyStockDelta(base.items, op.id, op.v, kind === 'in' ? q : -q)) {
      const entry = { d: op.date || '', id: Number(op.id), t: kind, q, by: op.by || '', v: op.v };
      if (op.rem) entry.rem = op.rem;
      base.log.unshift(entry);
      if (base.log.length > 600) base.log.length = 600;
    }
    base.updatedAt = Date.now();
    return { state: base };
  }

  if (op && op.type === 'issue_batch' && Array.isArray(op.rows)) {
    const base = cloneItemsAndLog(existing);
    const okRows = [];
    for (const r of op.rows) {
      const q = Math.max(0, Math.floor(Number(r && r.q) || 0));
      if (!r || !r.id || !r.v || q <= 0) continue;
      if (applyStockDelta(base.items, r.id, r.v, -q)) {
        okRows.push({ id: Number(r.id), t: 'out', q, by: op.by || '', v: r.v, d: op.date || '' });
      }
    }
    for (let i = okRows.length - 1; i >= 0; i--) base.log.unshift(okRows[i]);
    if (base.log.length > 600) base.log.length = 600;
    base.updatedAt = Date.now();
    return { state: base };
  }

  if (op && op.type === 'fac_add' && op.name) {
    const base = stripMeta(existing);
    base.fac = Array.isArray(base.fac) ? base.fac.slice() : [];
    const nm = String(op.name).trim();
    if (nm && !base.fac.some(x => String(x || '').trim().toLowerCase() === nm.toLowerCase())) {
      base.fac.push(nm);
    }
    base.updatedAt = Date.now();
    return { state: base };
  }

  if (op && op.type === 'bill_add' && op.bill) {
    const base = cloneItemsAndLog(existing);
    base.bills = Array.isArray(base.bills) ? base.bills.slice() : [];
    const maxBid = Math.max(Number(base.bid || 0), ...base.bills.map(b => Number(b && b.id) || 0));
    const bill = Object.assign({}, op.bill, { id: maxBid + 1 });
    base.bid = maxBid + 1;
    base.bills.push(bill);
    if (bill.stockAdded && Array.isArray(bill.lines)) {
      for (const l of bill.lines) {
        if (!l || !(Number(l[2]) > 0)) continue;
        applyStockDelta(base.items, l[0], l[1], Number(l[2]));
        base.log.unshift({ d: bill.date || '', id: Number(l[0]), t: 'in', q: Number(l[2]), by: bill.vendor || '', v: l[1] });
      }
      if (base.log.length > 600) base.log.length = 600;
    }
    base.updatedAt = Date.now();
    return { state: base, assignedId: bill.id };
  }

  if (op && op.type === 'bill_edit' && op.id != null && op.bill) {
    const base = cloneItemsAndLog(existing);
    base.bills = Array.isArray(base.bills) ? base.bills.slice() : [];
    const idx = base.bills.findIndex(b => b && Number(b.id) === Number(op.id));
    if (idx >= 0) {
      const prev = base.bills[idx];
      if (prev && prev.stockAdded !== false && Array.isArray(prev.lines)) {
        for (const l of prev.lines) {
          if (l && Number(l[2]) > 0) applyStockDelta(base.items, l[0], l[1], -Number(l[2]));
        }
      }
      const next = Object.assign({}, prev, op.bill, { id: Number(op.id) });
      if (next.stockAdded && Array.isArray(next.lines)) {
        for (const l of next.lines) {
          if (l && Number(l[2]) > 0) applyStockDelta(base.items, l[0], l[1], Number(l[2]));
        }
      }
      base.bills[idx] = next;
    }
    base.updatedAt = Date.now();
    return { state: base };
  }

  if (op && op.type === 'bill_del' && op.id != null) {
    const base = cloneItemsAndLog(existing);
    base.bills = Array.isArray(base.bills) ? base.bills.slice() : [];
    const prev = base.bills.find(b => b && Number(b.id) === Number(op.id));
    if (prev && prev.stockAdded !== false && Array.isArray(prev.lines)) {
      for (const l of prev.lines) {
        if (l && Number(l[2]) > 0) applyStockDelta(base.items, l[0], l[1], -Number(l[2]));
      }
    }
    base.bills = base.bills.filter(b => b && Number(b.id) !== Number(op.id));
    base.updatedAt = Date.now();
    return { state: base };
  }

  // 3. Full state update (legacy/fallback): never wipe populated server items or overwrite reqs/auth/prefs/carts
  if (!Array.isArray(cleanIncoming.items) || !cleanIncoming.items.length) {
    cleanIncoming.items = existing.items;
    cleanIncoming.uid = existing.uid;
  }
  const existingReqs = Array.isArray(existing.reqs) ? existing.reqs : [];
  const incomingReqs = Array.isArray(cleanIncoming.reqs) ? cleanIncoming.reqs : [];
  const incomingIds = new Set(incomingReqs.filter(r => r && r.id != null).map(r => Number(r.id)));
  const missingReqs = existingReqs.filter(r => r && r.id != null && !incomingIds.has(Number(r.id)));

  if (missingReqs.length > 0) {
    cleanIncoming.reqs = [...incomingReqs, ...missingReqs].sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
  }

  if (existing.auth || cleanIncoming.auth) {
    cleanIncoming.auth = mergeAuthState(existing.auth, cleanIncoming.auth);
  }
  if (existing.carts || cleanIncoming.carts) {
    cleanIncoming.carts = Object.assign({}, existing.carts || {}, cleanIncoming.carts || {});
  }
  if (existing.prefs || cleanIncoming.prefs) {
    cleanIncoming.prefs = mergePrefs(existing.prefs, cleanIncoming.prefs);
  }
  if (existing.devlock || cleanIncoming.devlock) {
    cleanIncoming.devlock = Object.assign({}, existing.devlock || {}, cleanIncoming.devlock || {});
  }

  cleanIncoming.updatedAt = Date.now();
  return { state: cleanIncoming };
}

function detectReqNotifications(prevReqs, nextReqs) {
  const notifications = [];
  if (!Array.isArray(nextReqs)) return notifications;

  const prevMap = {};
  if (Array.isArray(prevReqs)) {
    prevReqs.forEach(r => {
      if (r && r.id != null) prevMap[Number(r.id)] = r.st;
    });
  }

  const now = Date.now();
  for (const r of nextReqs) {
    if (!r || r.id == null) continue;
    const prevSt = prevMap[Number(r.id)];
    const slipNo = 'REQ-' + String(r.id).padStart(3, '0');

    if (prevSt === undefined && r.st === 'Pending') {
      const count = Array.isArray(r.it) ? r.it.length : 0;
      notifications.push({
        id: `req_new_${r.id}_${now}`,
        type: 'req_created',
        targetRole: ['principal', 'admin'],
        targetTeacher: null,
        title: '📋 New Requisition Slip Raised',
        body: `${r.by || 'Teacher'} has filled Requisition Slip #${slipNo} (${count} items). Awaiting approval.`,
        tag: `req-slip-${r.id}`,
        slipId: r.id,
        timestamp: now
      });
    } else if (prevSt === 'Pending' && r.st === 'Verified') {
      notifications.push({
        id: `req_ver_${r.id}_${now}`,
        type: 'req_verified',
        targetRole: ['admin'],
        targetTeacher: r.by || null,
        title: '✅ Requisition Slip Approved by Principal',
        body: `Principal approved Requisition Slip #${slipNo} for ${r.by}. Please issue the requested items.`,
        tag: `req-verified-${r.id}`,
        slipId: r.id,
        timestamp: now
      });
    } else if (prevSt === 'Verified' && r.st === 'Approved') {
      notifications.push({
        id: `req_app_${r.id}_${now}`,
        type: 'req_approved',
        targetRole: ['teacher'],
        targetTeacher: r.by || null,
        title: '📦 Requested Items Ready for Collection',
        body: `Your Requisition Slip #${slipNo} has been approved. You can collect your requested items from Admin.`,
        tag: `req-approved-${r.id}`,
        slipId: r.id,
        timestamp: now
      });
    } else if (prevSt && prevSt !== 'Declined' && r.st === 'Declined') {
      notifications.push({
        id: `req_dec_${r.id}_${now}`,
        type: 'req_declined',
        targetRole: ['teacher'],
        targetTeacher: r.by || null,
        title: '❌ Requisition Slip Declined',
        body: `Your Requisition Slip #${slipNo} was declined by ${r.declBy === 'principal' ? 'Principal' : 'Store Admin'}.`,
        tag: `req-declined-${r.id}`,
        slipId: r.id,
        timestamp: now
      });
    }
  }
  return notifications;
}

module.exports = { mergeAppState, detectReqNotifications };

