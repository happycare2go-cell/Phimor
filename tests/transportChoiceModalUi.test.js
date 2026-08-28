const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'liff-app', 'family', 'index.html'), 'utf8');

test('transparent toast cannot intercept transport modal taps and modal stacks above it', () => {
  const toastRule = source.match(/\.toast\{([^}]*)\}/)?.[1] || '';
  const modalRule = source.match(/\.modal-bg\{([^}]*)\}/)?.[1] || '';
  assert.match(toastRule, /pointer-events:none/);
  assert.match(toastRule, /z-index:99/);
  assert.match(modalRule, /z-index:100/);
  assert.match(source, /\.modal-actions \.btn\{[^}]*min-height:44px[^}]*touch-action:manipulation/);
});

test('confirmation action has explicit controls, busy restoration and retry-safe failure copy', () => {
  assert.match(source, /id="confirmActionCancelButton"/);
  assert.match(source, /confirmActionButton\.disabled=confirmBusy/);
  assert.match(source, /confirmActionCancelButton\.disabled=confirmBusy/);
  assert.match(source, /catch\(_error\)\{[\s\S]*confirmActionMessage\.textContent=confirmFailureMessage/);
  assert.match(source, /finally\{[\s\S]*setConfirmBusy\(false\)/);
  assert.match(source, /บันทึกวิธีเดินทางไม่สำเร็จ กรุณาลองอีกครั้ง/);
});

test('transport submit is bounded, deduped in-flight and refreshes only the originating profile generation', () => {
  assert.match(source, /const TRANSPORT_CHOICE_TIMEOUT_MS=15000/);
  assert.match(source, /const TRANSPORT_CHOICE_SUBMISSIONS=new Set\(\)/);
  assert.match(source, /TRANSPORT_CHOICE_SUBMISSIONS\.has\(planId\)/);
  assert.match(source, /signal:controller\.signal/);
  assert.match(source, /profileId===currentProfile\?\.profile\?\.care_profile_id&&generation===DASHBOARD_GENERATION/);
  assert.match(source, /toast\('บันทึกวิธีเดินทางแล้ว'\);await loadDashboard\(\)/);
  assert.match(source, /cancelConfirmForContextChange\(\)/);
});
