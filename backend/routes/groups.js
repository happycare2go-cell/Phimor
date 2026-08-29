const express = require('express');
const router = express.Router();
const { requireAuth, requireCenterStaff, requireFamilyAccess } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const service = require('../services/groupBindingService');

router.use(requireAuth);

router.post('/center/:centerId/group-binding-token', requireCenterStaff(), asyncHandler(async (req, res) => {
  const result = await service.createStaffBindingToken(req.params.centerId, req.user.lineUserId);
  if (!result.ok) return res.status(403).json({ error: 'forbidden', message: result.reason });
  res.status(201).json(result);
}));

router.post('/care-profile/:careProfileId/group-binding-token', requireFamilyAccess(), asyncHandler(async (req, res) => {
  const result = await service.createFamilyBindingToken(req.params.careProfileId, req.user.lineUserId);
  if (!result.ok) {
    const conflict = ['FAMILY_GROUP_ALREADY_BOUND', 'FAMILY_GROUP_CODE_ACTIVE'].includes(result.code);
    const status = conflict ? 409 : 403;
    const error = result.code === 'FAMILY_GROUP_ALREADY_BOUND' ? 'already_bound'
      : result.code === 'FAMILY_GROUP_CODE_ACTIVE' ? 'binding_code_active' : 'forbidden';
    return res.status(status).json({ error, message:result.reason });
  }
  res.status(201).json(result);
}));

module.exports = router;
