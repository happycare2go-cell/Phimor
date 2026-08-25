const { asyncHandler } = require('./asyncHandler');
const { createPharmacistAccountService } = require('../services/pharmacistAccountService');

function createRequirePharmacist({ pharmacistAccounts = createPharmacistAccountService() } = {}) {
  return asyncHandler(async (req, res, next) => {
    if (!req.user?.lineUserId) {
      return res.status(401).json({ error:'unauthorized', message:'กรุณาเข้าสู่ระบบผ่าน LINE ใหม่อีกครั้ง' });
    }
    try {
      const pharmacist = await pharmacistAccounts.requireActive(req.user.lineUserId);
      req.pharmacist = Object.freeze({
        pharmacistId:pharmacist.pharmacistId,
        displayName:pharmacist.displayName,
      });
      next();
    } catch (_) {
      return res.status(403).json({ error:'pharmacist_access_denied', message:'บัญชีนี้ไม่มีสิทธิ์ใช้งานระบบเภสัชกร' });
    }
  });
}

const requirePharmacist = createRequirePharmacist();
module.exports = { createRequirePharmacist, requirePharmacist };
