// middleware/auth.js
// ตรวจสอบตัวตนและสิทธิ์ — ทุก Endpoint ต้องผ่านมิดเดิลแวร์นี้ก่อนเสมอ
// (ตาม Phimor_Technical_Design.docx หมวด 5 และหมวด 8 ความปลอดภัย)
//
// Production ตรวจ LINE ID Token กับ LINE Login ก่อนเสมอ ส่วน X-Line-User-Id
// อนุญาตเฉพาะ test/local ที่เปิด ALLOW_INSECURE_LINE_HEADER ชัดเจนเท่านั้น

const { CenterStaff, Centers, Residents, CareProfiles, CareProfileMembers } = require('../db');
const { asyncHandler } = require('./asyncHandler');

const DEFAULT_LINE_VERIFY_TIMEOUT_MS = 5000;

function lineVerifyTimeoutMs(env = process.env) {
  const parsed = Number(env.LINE_VERIFY_TIMEOUT_MS);
  return Number.isInteger(parsed) && parsed >= 250 && parsed <= 15000
    ? parsed : DEFAULT_LINE_VERIFY_TIMEOUT_MS;
}

async function verifyLineIdToken(idToken, {
  clientId = process.env.LINE_LOGIN_CHANNEL_ID,
  fetchImpl = globalThis.fetch,
  timeoutMs = lineVerifyTimeoutMs(),
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  if (!idToken || !clientId) return null;
  const body = new URLSearchParams({ id_token: idToken, client_id: clientId });
  const controller = new AbortController();
  const timer = schedule(() => controller.abort(), timeoutMs);
  timer?.unref?.();
  try {
    const response = await fetchImpl('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
      signal:controller.signal,
    });
    if (!response.ok) return null;
    const claims = await response.json();
    return claims?.sub ? { lineUserId: claims.sub, claims } : null;
  } catch (_) {
    return null;
  } finally {
    cancel(timer);
  }
}

/** Production ต้องใช้ LINE ID Token; header ตรงอนุญาตเฉพาะ local/test ที่เปิด flag ชัดเจน */
function insecureLineHeaderAllowed(env = process.env) {
  return env.NODE_ENV === 'test'
    || (env.NODE_ENV !== 'production' && env.ALLOW_INSECURE_LINE_HEADER === 'true');
}

async function identify(req, { env = process.env, verify = verifyLineIdToken } = {}) {
  const authorization = req.header('Authorization') || '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : null;
  const verified = await verify(bearer);
  if (verified) return verified;
  if (insecureLineHeaderAllowed(env)) {
    const lineUserId = req.header('X-Line-User-Id');
    if (lineUserId) return { lineUserId, insecureDevelopmentIdentity: true };
  }
  return null;
}

const requireAuth = asyncHandler(async (req, res, next) => {
  const user = await identify(req);
  if (!user) {
    return res.status(401).json({ error: 'unauthorized', message: 'ไม่พบตัวตนผู้ใช้ กรุณาเข้าสู่ระบบผ่าน LINE ใหม่อีกครั้ง' });
  }
  req.user = user;
  next();
});

/**
 * ต้องเป็นเจ้าของหรือผู้จัดการของศูนย์ที่ระบุใน req.params.centerId (หรือ req.body.centerId)
 * — ใช้กับ FR-A, FR-B, FR-K, FR-L (ฝั่งศูนย์), FR-M ตามข้อกำหนด "เจ้าของ/ผู้จัดการเท่านั้น"
 */
function requireCenterStaff(roles = ['owner', 'manager'], options = {}) {
  return asyncHandler(async (req, res, next) => {
    // Record-bound routes may resolve an authoritative Center before this
    // middleware runs. Prefer it over every client-supplied Center value.
    const centerId = req.authoritativeCenterId || req.params.centerId || req.body?.centerId || req.query.centerId;
    if (!centerId) {
      return res.status(400).json({ error: 'bad_request', message: 'ไม่ระบุศูนย์' });
    }
    const staffRows = await CenterStaff.findWhereByFields({
      center_id:centerId, line_user_id:req.user.lineUserId,
    });
    const staff = staffRows.find((s) => roles.includes(s.role) && (!s.status || s.status === 'active')) || null;
    if (!staff) {
      if (options.maskUnauthorized) {
        return res.status(404).json({ error: 'not_found', message: 'ไม่พบข้อมูล' });
      }
      return res.status(403).json({ error: 'forbidden', message: 'คุณไม่มีสิทธิ์จัดการศูนย์นี้' });
    }
    const center = await Centers.findOneByFields({ center_id:centerId });
    const subscription = require('../services/subscriptionService').entitlement(center);
    if (!subscription.allowed) {
      const message = subscription.code === 'center_suspended'
        ? 'ศูนย์นี้ถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ'
        : subscription.code === 'subscription_not_started'
          ? 'สิทธิการใช้ระบบของศูนย์ยังไม่เริ่ม กรุณาติดต่อเจ้าหน้าที่'
          : 'แพ็กเกจพี่หมอของศูนย์หมดอายุแล้ว กรุณาติดต่อเจ้าหน้าที่เพื่อต่ออายุ';
      return res.status(402).json({ error: subscription.code, message, subscription });
    }
    req.centerId = centerId;
    req.staffRole = staff.role;
    req.center = center;
    req.subscription = subscription;
    next();
  });
}

/**
 * ผู้เรียกต้องเป็นพนักงาน (ทุกระดับ รวมพนักงานทั่วไปที่ไม่ต้องลงทะเบียน) ของศูนย์นี้
 * ใช้กับ Endpoint ที่ทำงานผ่านกลุ่มไลน์งานศูนย์ (FR-C ถึง FR-F)
 * — พนักงานทั่วไประบุตัวตนผ่าน group_id ที่ผูกกับศูนย์ ไม่ใช่ผ่าน CenterStaff
 */
async function resolveCenterByGroup(groupId) {
  return require('../services/centerService').findCenterByGroup(groupId);
}

/**
 * ต้องเป็นครอบครัวที่ผูก Care Profile นี้อยู่จริง
 * ใช้กับ FR-H (ฝั่งครอบครัว)
 */
function requireFamilyAccess() {
  return asyncHandler(async (req, res, next) => {
    const careProfileId = req.params.careProfileId || req.body.careProfileId;
    if (!careProfileId) {
      return res.status(400).json({ error: 'bad_request', message: 'ไม่ระบุ Care Profile' });
    }
    const profile = await CareProfiles.findOneByFields({ care_profile_id:careProfileId });
    if (!profile) {
      return res.status(404).json({ error: 'not_found', message: 'ไม่พบข้อมูล' });
    }
    const member = await CareProfileMembers.findOneByFields({
      care_profile_id:careProfileId, line_user_id:req.user.lineUserId, status:'active',
    });
    if (profile.owner_line_id !== req.user.lineUserId && !member) {
      return res.status(403).json({ error: 'forbidden', message: 'คุณไม่มีสิทธิ์เข้าถึงข้อมูลนี้' });
    }
    req.careProfile = profile;
    req.familyRole = profile.owner_line_id === req.user.lineUserId ? 'owner' : member.role;
    // A legacy membership without an explicit permission array must never
    // acquire medication mutation authority merely by being a member. Existing
    // rows which explicitly contain manage_medications retain that permission.
    req.familyPermissions = req.familyRole === 'owner' ? ['*']
      : (member.permissions || ['view','edit_profile','manage_appointments','decide_transport']);
    next();
  });
}

/**
 * ตรวจว่าศูนย์เข้าถึง Care Profile ของผู้พักรายนี้ได้จริง — ใช้ตรวจซ้ำระดับ Query
 * ตามข้อกำหนดในหมวดความปลอดภัย: "ต้องตรวจสอบระดับ Query ไม่ใช่แค่ซ่อนใน UI"
 * และข้อ B5: จำหน่ายออกแล้วต้องเพิกถอนสิทธิ์ทันที
 */
async function centerCanAccessResident(centerId, residentId) {
  const center = await Centers.findOneByFields({ center_id:centerId });
  if (!require('../services/subscriptionService').entitlement(center).allowed) return false;
  const resident = await Residents.findOneByFields({ resident_id:residentId });
  if (!resident) return false;
  return resident.center_id === centerId && resident.status === 'active';
}

module.exports = {
  identify, verifyLineIdToken, lineVerifyTimeoutMs, DEFAULT_LINE_VERIFY_TIMEOUT_MS,
  insecureLineHeaderAllowed, requireAuth, requireCenterStaff, requireFamilyAccess,
  resolveCenterByGroup, centerCanAccessResident,
};
