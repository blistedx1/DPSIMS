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

  const hasExisting = existing && Array.isArray(existing.items) && existing.items.length > 0;
  if (!hasExisting) {
    cleanIncoming.updatedAt = Date.now();
    return { state: cleanIncoming };
  }

  const op = incoming._op;

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
    const base = stripMeta(existing);
    base.reqs = Array.isArray(base.reqs) ? base.reqs.slice() : [];
    base.items = Array.isArray(base.items) ? base.items.map(it => Object.assign({}, it, { v: Array.isArray(it.v) ? it.v.map(x => x.slice()) : [] })) : [];
    base.log = Array.isArray(base.log) ? base.log.slice() : [];

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
        const item = base.items.find(it => it && Number(it.id) === Number(d.id));
        if (item && Array.isArray(item.v)) {
          const variant = item.v.find(v => v && v[0] === d.v);
          if (variant) {
            variant[1] = Math.max(0, Number(variant[1] || 0) - Number(d.q));
          }
        }
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

  // 3. Full state update (Admin bills, items, faculty, direct stock adjustments, etc.):
  // Preserve any newly submitted teacher slips from server state that aren't in incoming.reqs
  const existingReqs = Array.isArray(existing.reqs) ? existing.reqs : [];
  const incomingReqs = Array.isArray(cleanIncoming.reqs) ? cleanIncoming.reqs : [];
  const incomingIds = new Set(incomingReqs.filter(r => r && r.id != null).map(r => Number(r.id)));
  const missingReqs = existingReqs.filter(r => r && r.id != null && !incomingIds.has(Number(r.id)));

  if (missingReqs.length > 0) {
    cleanIncoming.reqs = [...incomingReqs, ...missingReqs].sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
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
