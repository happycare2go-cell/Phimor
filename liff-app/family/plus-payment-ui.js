(function initPlusPaymentUI(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PhimorPlusPaymentUI = api;
}(typeof window !== 'undefined' ? window : globalThis, function plusPaymentFactory() {
  const RETURN_TARGETS = Object.freeze({
    lab_explanation: 'อธิบายผลตรวจด้วย AI',
    doctor_question_prep: 'ถามหมออะไรดี',
    doctor_visit_organization: 'ช่วยจัดระเบียบสิ่งที่หมอบอก',
    plus_home: 'พี่หมอ Plus',
  });
  const LIVE_BENEFITS = Object.freeze([
    'อธิบายผลตรวจด้วย AI',
    'เตรียมคำถามก่อนพบแพทย์',
    'ช่วยจัดระเบียบสิ่งที่หมอบอก',
    'สรุปข้อมูลสุขภาพที่บันทึกไว้และสิ่งที่เปลี่ยนในรายการยา',
  ]);

  function activeEntitlement(value) {
    return Boolean(value && value.status === 'active' && value.plus === true
      && ['internal', 'promotion', 'payment'].includes(value.source));
  }

  function safeQr(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
    } catch (_) { return null; }
  }

  function formatThaiDate(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return 'ยังไม่ระบุ';
    return date.toLocaleDateString('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' });
  }

  function makeIdempotencyKey() {
    const cryptoApi = typeof crypto !== 'undefined' ? crypto : null;
    const token = cryptoApi?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `plus-${token}`.slice(0, 80);
  }

  function createSession({ request, onChange = () => {}, onReturn = () => {} } = {}) {
    let generation = 0;
    const state = {
      profileId: null, view: 'loading', entitlement: null, offer: null,
      order: null, history: [], nextCursor: null, returnTarget: 'plus_home',
      contextLabel: '', loading: false, errorCode: null,
    };
    const snapshot = () => ({ ...state, history: [...state.history] });
    const notify = () => onChange(snapshot());
    const current = (token) => token === generation;

    async function load() {
      const token = ++generation; state.loading = true; state.errorCode = null; state.view = 'loading'; notify();
      try {
        const [offer, entitlement, currentOrder] = await Promise.all([
          request('/api/plus/offer'), request('/api/plus/entitlement'), request('/api/plus/orders/current'),
        ]);
        if (!current(token)) return { ignored: true, stale: true };
        state.offer = offer; state.entitlement = entitlement;
        state.order = currentOrder?.order || null;
        state.view = state.order ? 'payment' : 'membership';
        return snapshot();
      } catch (error) {
        if (current(token)) { state.view = 'membership'; state.errorCode = error?.errorCode || 'PLUS_LOAD_FAILED'; }
        return { status: 'unavailable' };
      } finally {
        if (current(token)) { state.loading = false; notify(); }
      }
    }

    async function requestCapability(target) {
      if (!RETURN_TARGETS[target]) return { ignored: true };
      state.returnTarget = target; state.contextLabel = RETURN_TARGETS[target]; state.errorCode = null;
      if (activeEntitlement(state.entitlement)) {
        onReturn(target); return { allowed: true };
      }
      state.view = 'context'; notify(); return { allowed: false };
    }

    function showOffer(target = null) {
      if (target && RETURN_TARGETS[target]) state.returnTarget = target;
      state.view = 'offer'; state.errorCode = null; notify();
    }
    function showMembership() { state.view = 'membership'; state.returnTarget = 'plus_home'; state.contextLabel = ''; notify(); }

    async function createCheckout({ renew = false } = {}) {
      if (state.loading) return { ignored: true };
      const token = generation; state.loading = true; state.errorCode = null; notify();
      try {
        const result = await request('/api/plus/orders', {
          method: 'POST',
          body: JSON.stringify({
            returnTarget: state.returnTarget,
            idempotencyKey: makeIdempotencyKey(),
            renew: renew === true,
          }),
        });
        if (!current(token)) return { ignored: true, stale: true };
        if (!result?.orderId || ['rejected', 'unavailable'].includes(result.status)) {
          state.errorCode = result?.errorCode || 'PLUS_CHECKOUT_FAILED'; return result;
        }
        state.order = result; state.view = 'payment'; return result;
      } catch (error) {
        if (current(token)) state.errorCode = error?.errorCode || 'PLUS_CHECKOUT_FAILED';
        return { status: 'unavailable' };
      } finally {
        if (current(token)) { state.loading = false; notify(); }
      }
    }

    async function refreshOrder() {
      if (!state.order?.orderId || state.loading) return { ignored: true };
      const token = generation; state.loading = true; notify();
      try {
        const order = await request(`/api/plus/orders/${encodeURIComponent(state.order.orderId)}/status`);
        if (!current(token)) return { ignored: true, stale: true };
        state.order = order;
        if (order.status === 'active') {
          state.entitlement = await request('/api/plus/entitlement');
          if (!current(token)) return { ignored: true, stale: true };
          state.view = 'success'; notify(); onReturn(state.returnTarget);
        }
        return order;
      } catch (error) {
        if (current(token)) state.errorCode = error?.errorCode || 'PLUS_STATUS_FAILED';
        return { status: 'unavailable' };
      } finally {
        if (current(token)) { state.loading = false; notify(); }
      }
    }

    async function loadHistory({ append = false } = {}) {
      const token = generation; state.loading = true; state.errorCode = null; notify();
      try {
        const cursor = append ? state.nextCursor : null;
        const result = await request(`/api/plus/orders/history?limit=20${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`);
        if (!current(token)) return { ignored: true, stale: true };
        const rows = Array.isArray(result?.orders) ? result.orders : [];
        const seen = new Set(append ? state.history.map((item) => item.orderId) : []);
        state.history = append ? [...state.history, ...rows.filter((item) => !seen.has(item.orderId))] : rows;
        state.nextCursor = result?.nextCursor || null; state.view = 'history'; return result;
      } finally {
        if (current(token)) { state.loading = false; notify(); }
      }
    }

    return {
      snapshot, load, requestCapability, showOffer, showMembership,
      createCheckout, refreshOrder, loadHistory,
      setProfile(profileId) {
        if (state.profileId === profileId) return false;
        generation += 1; state.profileId = profileId || null; state.returnTarget = 'plus_home';
        state.contextLabel = ''; state.order = null; state.history = []; state.nextCursor = null;
        state.errorCode = null; state.loading = false; state.view = 'membership'; notify(); return true;
      },
    };
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function text(doc, parent, tag, className, value) {
    const node = doc.createElement(tag); node.className = className || ''; node.textContent = value || '';
    parent.appendChild(node); return node;
  }

  function createController({ doc, session, pollMs = 5000 } = {}) {
    const panel = doc.getElementById('plusCommercePanel');
    const content = doc.getElementById('plusCommerceContent');
    let pollHandle = null;
    const stopPolling = () => { if (pollHandle) clearInterval(pollHandle); pollHandle = null; };
    const startPolling = () => {
      stopPolling();
      pollHandle = setInterval(() => session.refreshOrder(), Math.max(2000, pollMs));
    };

    function button(parent, label, className, handler) {
      const node = text(doc, parent, 'button', className, label); node.type = 'button'; node.addEventListener('click', handler); return node;
    }

    function renderMembership(state) {
      const active = activeEntitlement(state.entitlement);
      const expired = state.entitlement?.status === 'expired';
      text(doc, content, 'span', `plus-plan-chip ${active ? 'plus-plan-chip--active' : ''}`, active ? 'พี่หมอ Plus' : 'พี่หมอ Free');
      text(doc, content, 'h3', '', active ? 'พี่หมอ Plus กำลังใช้งาน' : 'สิทธิ์ปัจจุบันของคุณ');
      if (active) text(doc, content, 'p', 'plus-commerce__lead', `ใช้งานได้ถึง ${formatThaiDate(state.entitlement.expiresAt)}`);
      else if (expired) text(doc, content, 'p', 'plus-commerce__lead', 'พี่หมอ Plus หมดอายุแล้ว ข้อมูลสุขภาพที่คุณบันทึกยังดูได้ตามปกติ');
      else text(doc, content, 'p', 'plus-commerce__lead', 'ข้อมูลสุขภาพที่คุณบันทึกยังดูได้ตามปกติ ฟีเจอร์ AI ใช้ได้เมื่อสมัคร Plus');
      text(doc, content, 'p', 'plus-no-renew', 'ไม่มีการตัดเงินอัตโนมัติ');
      button(content, active ? 'ต่ออายุ — 59 บาท / 30 วัน' : expired ? 'ต่ออายุ 59 บาท / 30 วัน' : 'ดูพี่หมอ Plus', 'btn btn-primary', () => {
        session.showOffer('plus_home');
      });
      button(content, 'ประวัติการชำระ Plus', 'btn btn-outline', () => session.loadHistory());
    }

    function renderOffer(state, contextual) {
      if (contextual) {
        text(doc, content, 'p', 'plus-context-label', `ต้องการใช้ “${state.contextLabel}”?`);
        text(doc, content, 'p', '', 'ฟีเจอร์นี้รวมอยู่ในพี่หมอ Plus');
      }
      text(doc, content, 'h3', 'plus-offer-title', 'พี่หมอ Plus');
      text(doc, content, 'div', 'plus-offer-price', '59 บาท / 30 วัน');
      text(doc, content, 'p', 'plus-commerce__lead', 'พี่หมอช่วยสรุป ช่วยเตรียม และช่วยจำเรื่องสุขภาพให้คุณ');
      const list = doc.createElement('ul'); list.className = 'plus-benefits';
      LIVE_BENEFITS.forEach((item) => text(doc, list, 'li', '', item)); content.appendChild(list);
      text(doc, content, 'p', 'plus-plan-rule', 'ใช้งาน Plus ได้ 30 วันนับจากวันที่ชำระสำเร็จ');
      text(doc, content, 'p', 'plus-plan-rule', 'ครบกำหนดแล้วสามารถต่ออายุได้โดยชำระอีกครั้ง');
      text(doc, content, 'p', 'plus-no-renew', 'ไม่มีการตัดเงินอัตโนมัติ');
      const renew = activeEntitlement(state.entitlement);
      if (renew) {
        text(doc, content, 'p', 'plus-plan-rule', `วันใช้งานที่เหลือจะไม่หาย 30 วันใหม่เริ่มต่อจาก ${formatThaiDate(state.entitlement.expiresAt)}`);
      }
      button(content, renew ? 'ต่ออายุพี่หมอ Plus — 59 บาท' : 'สมัครพี่หมอ Plus — 59 บาท', 'btn btn-gold', () => session.createCheckout({ renew }));
      button(content, 'ไว้ก่อน', 'btn btn-outline', () => session.showMembership());
    }

    function renderPayment(state) {
      const order = state.order || {};
      text(doc, content, 'h3', '', 'พี่หมอ Plus · 59 บาท / 30 วัน');
      const labels = {
        checkout_preparing: 'กำลังเตรียมรายการชำระเงิน',
        payment_pending: 'ยังไม่ได้ชำระ • ใช้ QR เดิมสำหรับรายการนี้',
        payment_confirming: 'กำลังตรวจสอบการชำระเงิน',
        failed: 'ชำระเงินไม่สำเร็จ', expired: 'รายการชำระเงินหมดอายุแล้ว', cancelled: 'ยกเลิกรายการแล้ว',
      };
      text(doc, content, 'p', `plus-payment-state plus-payment-state--${order.status || 'pending'}`, labels[order.status] || 'กำลังตรวจสอบรายการ');
      text(doc, content, 'p', 'plus-payment-reference', `เลขอ้างอิง: ${order.orderId || 'กำลังสร้าง'}`);
      const qr = safeQr(order.payment?.qrImageUrl);
      if (order.status === 'payment_pending' && qr) {
        const image = doc.createElement('img'); image.className = 'plus-payment-qr'; image.src = qr; image.alt = 'PromptPay QR สำหรับสมัครพี่หมอ Plus'; content.appendChild(image);
      }
      text(doc, content, 'p', 'plus-no-renew', 'ไม่มีการตัดเงินอัตโนมัติ');
      if (['checkout_preparing', 'payment_pending', 'payment_confirming'].includes(order.status)) {
        button(content, 'ตรวจสอบสถานะอีกครั้ง', 'btn btn-primary', () => session.refreshOrder()); startPolling();
      } else {
        stopPolling(); button(content, 'กลับไปดูพี่หมอ Plus', 'btn btn-outline', () => session.showMembership());
      }
    }

    function renderHistory(state) {
      text(doc, content, 'h3', '', 'ประวัติการชำระพี่หมอ Plus');
      if (!state.history.length) text(doc, content, 'p', 'plus-empty', 'ยังไม่มีประวัติการชำระพี่หมอ Plus');
      state.history.forEach((item) => {
        const row = doc.createElement('article'); row.className = 'plus-history-row';
        text(doc, row, 'strong', '', '59 บาท');
        text(doc, row, 'span', '', `${formatThaiDate(item.paidAt || item.createdAt)} · ${item.status === 'active' ? 'ชำระสำเร็จ' : item.status === 'payment_pending' ? 'รอชำระ' : 'ไม่สำเร็จ/หมดอายุ'}`);
        if (item.entitlementStartAt && item.entitlementEndAt) text(doc, row, 'small', '', `สิทธิ์ ${formatThaiDate(item.entitlementStartAt)} – ${formatThaiDate(item.entitlementEndAt)}`);
        content.appendChild(row);
      });
      if (state.nextCursor) button(content, 'โหลดรายการเพิ่ม', 'btn btn-outline', () => session.loadHistory({ append: true }));
      button(content, 'กลับ', 'btn btn-outline', () => session.showMembership());
    }

    function render(state) {
      panel.hidden = false; clear(content); stopPolling();
      if (state.loading && state.view === 'loading') text(doc, content, 'p', 'plus-loading', 'กำลังตรวจสอบสิทธิ์พี่หมอ Plus...');
      else if (state.view === 'context') renderOffer(state, true);
      else if (state.view === 'offer') renderOffer(state, false);
      else if (state.view === 'payment') renderPayment(state);
      else if (state.view === 'success') {
        text(doc, content, 'h3', '', 'เปิดใช้พี่หมอ Plus แล้ว');
        text(doc, content, 'p', 'plus-commerce__lead', `ใช้งานได้ถึง ${formatThaiDate(state.entitlement?.expiresAt)}`);
        text(doc, content, 'p', 'plus-plan-rule', 'กำลังกลับไปยังฟีเจอร์ที่คุณเลือก');
      } else if (state.view === 'history') renderHistory(state);
      else renderMembership(state);
      if (state.errorCode) text(doc, content, 'p', 'plus-commerce__error', 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่ โดยระบบจะไม่สร้างรายการชำระซ้ำ');
      content.querySelectorAll?.('button').forEach((node) => { node.disabled = state.loading; });
    }

    return { render, destroy: stopPolling };
  }

  return {
    RETURN_TARGETS, LIVE_BENEFITS, activeEntitlement, safeQr, formatThaiDate,
    makeIdempotencyKey, createSession, createController,
  };
}));
