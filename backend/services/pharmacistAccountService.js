const { createConsultationRepository } = require('./consultationRepository');
const { ConsultationDomainError } = require('../domain/consultation');

function projectPharmacist(account) {
  if (!account) return null;
  return Object.freeze({
    pharmacistId: account.pharmacist_id,
    lineUserId: account.line_user_id,
    displayName: account.display_name,
    licenseNumber: account.license_number,
    licenseVerifiedAt: account.license_verified_at || null,
    status: account.status,
  });
}

function createPharmacistAccountService({ repository = createConsultationRepository() } = {}) {
  async function getByLineIdentity(lineUserId) {
    if (typeof lineUserId !== 'string' || !lineUserId.trim()) {
      throw new ConsultationDomainError('UNAUTHENTICATED', 401);
    }
    return projectPharmacist(await repository.findPharmacistByLineUserId(lineUserId.trim()));
  }

  async function requireActive(lineUserId) {
    const account = await getByLineIdentity(lineUserId);
    if (!account) throw new ConsultationDomainError('PHARMACIST_NOT_FOUND', 403);
    if (account.status !== 'active') throw new ConsultationDomainError('PHARMACIST_INACTIVE', 403);
    if (!account.licenseVerifiedAt) throw new ConsultationDomainError('PHARMACIST_LICENSE_NOT_VERIFIED', 403);
    return account;
  }

  async function requireActiveById(pharmacistId) {
    if (typeof pharmacistId !== 'string' || !pharmacistId.trim()) {
      throw new ConsultationDomainError('PHARMACIST_NOT_FOUND', 403);
    }
    const account = projectPharmacist(await repository.findPharmacistById(pharmacistId.trim()));
    if (!account) throw new ConsultationDomainError('PHARMACIST_NOT_FOUND', 403);
    if (account.status !== 'active') throw new ConsultationDomainError('PHARMACIST_INACTIVE', 403);
    if (!account.licenseVerifiedAt) throw new ConsultationDomainError('PHARMACIST_LICENSE_NOT_VERIFIED', 403);
    return account;
  }

  return { getByLineIdentity, requireActive, requireActiveById };
}

const defaultService = createPharmacistAccountService();
module.exports = {
  projectPharmacist, createPharmacistAccountService,
  getPharmacistByLineIdentity: defaultService.getByLineIdentity,
  requireActivePharmacist: defaultService.requireActive,
};
