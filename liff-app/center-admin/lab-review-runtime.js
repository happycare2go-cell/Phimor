(function exposeCenterLabReviewRuntime(root, factory) {
  const runtime = factory();
  if (typeof module === 'object' && module.exports) module.exports = runtime;
  if (root) root.PhimorCenterLabReview = runtime;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createCenterLabReviewRuntime() {
  'use strict';

  const SAFE_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
  const SOURCE_MESSAGES = Object.freeze({
    loading: 'กำลังโหลดเอกสารต้นฉบับ...',
    available: 'เอกสารต้นฉบับพร้อมสำหรับตรวจสอบ',
    purged: 'เอกสารต้นฉบับถูกลบตามระยะเวลาการเก็บรักษาแล้ว ข้อมูลผล Lab ที่ยืนยันแล้วไม่ได้ถูกลบ',
    unavailable: 'ไม่พบเอกสารต้นฉบับสำหรับรายการนี้',
    unsupported: 'ไม่สามารถแสดงเอกสารต้นฉบับชนิดนี้ได้',
  });

  function sourceImageView(payload = {}) {
    const source = payload.sourceImage && typeof payload.sourceImage === 'object'
      ? payload.sourceImage : {};
    const status = source.status || (payload.imageBase64 ? 'available' : 'unavailable');
    if (status === 'purged') {
      return { status, message: SOURCE_MESSAGES.purged, dataUrl: null, mimeType: null };
    }
    if (status === 'unavailable') {
      return { status, message: SOURCE_MESSAGES.unavailable, dataUrl: null, mimeType: null };
    }
    if (status === 'unsupported') {
      return { status, message: SOURCE_MESSAGES.unsupported, dataUrl: null, mimeType: null };
    }

    const mimeType = source.mimeType || payload.imageMimeType || null;
    if (!payload.imageBase64) {
      return { status: 'unavailable', message: SOURCE_MESSAGES.unavailable, dataUrl: null, mimeType: null };
    }
    if (!SAFE_IMAGE_MIME_TYPES.has(mimeType)) {
      return { status: 'unsupported', message: SOURCE_MESSAGES.unsupported, dataUrl: null, mimeType: null };
    }
    return {
      status: 'available',
      message: SOURCE_MESSAGES.available,
      dataUrl: `data:${mimeType};base64,${payload.imageBase64}`,
      mimeType,
    };
  }

  function safeUncertainFields(value) {
    if (!Array.isArray(value)) return [];
    return value
      .filter((item) => typeof item === 'string' && item.trim())
      .slice(0, 100)
      .map((item) => item.normalize('NFC').trim().slice(0, 200));
  }

  function resetSourceImageElements({ image, status, noImage }) {
    image.removeAttribute('src');
    image.style.display = 'none';
    noImage.textContent = '';
    noImage.style.display = 'none';
    status.dataset.state = 'loading';
    status.textContent = SOURCE_MESSAGES.loading;
    status.style.display = 'block';
  }

  function renderSourceImageElements(elements, payload) {
    resetSourceImageElements(elements);
    const view = sourceImageView(payload);
    elements.status.dataset.state = view.status;
    elements.status.textContent = view.message;
    if (view.status === 'available') {
      elements.image.src = view.dataUrl;
      elements.image.style.display = 'block';
    }
    return view;
  }

  function createRequestRevisionGuard() {
    let revision = 0;
    return Object.freeze({
      begin() { revision += 1; return revision; },
      isCurrent(token) { return token === revision; },
      invalidate() { revision += 1; return revision; },
      current() { return revision; },
    });
  }

  return Object.freeze({
    SAFE_IMAGE_MIME_TYPES,
    SOURCE_MESSAGES,
    sourceImageView,
    safeUncertainFields,
    resetSourceImageElements,
    renderSourceImageElements,
    createRequestRevisionGuard,
  });
}));
