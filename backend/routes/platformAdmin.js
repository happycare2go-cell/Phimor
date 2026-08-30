const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { platformService: defaultPlatformService } = require('../services/platformService');
const { integrationEventService: defaultIntegrationEventService } = require('../services/integrationEventService');
const { PlatformError } = require('../domain/platform');

function serviceFor(req) {
  return req.app.locals.platformService || defaultPlatformService;
}

function eventServiceFor(req) {
  return req.app.locals.integrationEventService || defaultIntegrationEventService;
}

function actorFor(req) {
  return req.admin?.admin?.admin_id || (req.admin?.authMethod === 'api_key' ? 'admin:key' : 'admin:unknown');
}

function sendPlatformError(res, error) {
  const status = Number(error?.status) || 500;
  return res.status(status).json({
    error: status >= 500 ? 'internal_error' : status === 404 ? 'not_found'
      : status === 403 ? 'forbidden' : status === 401 ? 'unauthorized'
        : status === 409 ? 'conflict' : 'bad_request',
    errorCode: error?.code || 'PLATFORM_OPERATION_FAILED',
    message: status >= 500 ? 'ดำเนินการ Platform ไม่สำเร็จ' : error.message,
  });
}

function platformAction(handler) {
  return asyncHandler(async (req, res) => {
    try { return await handler(req, res, serviceFor(req), actorFor(req)); }
    catch (error) { return sendPlatformError(res, error); }
  });
}

function assertBodyKeys(body, allowed) {
  const unknown = Object.keys(body || {}).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new PlatformError('UNKNOWN_REQUEST_FIELD', 'คำขอมีข้อมูลที่ระบบไม่รองรับ', 400);
}

function createPlatformAdminRouter() {
  const router = express.Router();

  router.get('/organizations', platformAction(async (req, res, service) => {
    res.json({ organizations: await service.listOrganizations() });
  }));

  router.get('/pending-subjects', platformAction(async (req, res) => {
    res.json(await eventServiceFor(req).listPendingSubjects({
      integrationClientId:req.query.integrationClientId || null,
      organizationId:req.query.organizationId || null,
      centerId:req.query.centerId || null,
      externalCenterId:req.query.externalCenterId || null,
      externalResidentId:req.query.externalResidentId || null,
      search:req.query.search || null,
      limit:req.query.limit,
    }));
  }));

  router.post('/pending-subjects/map', platformAction(async (req, res, service, actorReference) => {
    res.json(await eventServiceFor(req).mapPendingSubject({
      integrationClientId:req.body.integrationClientId,
      externalCenterId:req.body.externalCenterId,
      externalResidentId:req.body.externalResidentId,
      residentId:req.body.residentId,
      actorReference,
    }));
  }));

  router.get('/integration-events/status', platformAction(async (req, res) => {
    res.json(await eventServiceFor(req).listOperationalStatus({
      integrationClientId:req.query.integrationClientId || null,
      organizationId:req.query.organizationId || null,
      centerId:req.query.centerId || null,
      groupStatus:req.query.groupStatus || null,
      limit:req.query.limit,
    }));
  }));

  router.get('/integration-identity-alerts', platformAction(async (req, res, service) => {
    res.json(await service.listIntegrationAlerts({
      integrationClientId:req.query.integrationClientId || null,
      status:req.query.status || null, limit:req.query.limit,
    }));
  }));

  router.patch('/integration-identity-alerts/:alertId/status', platformAction(async (req, res, service, actorReference) => {
    const body = req.body || {}; assertBodyKeys(body, ['status']);
    res.json({ alert:await service.updateIntegrationAlertStatus({
      alertId:req.params.alertId, status:body.status, actorReference,
    }) });
  }));

  router.post('/integration-events/:integrationEventId/reconcile-group', platformAction(async (req, res) => {
    res.json(await eventServiceFor(req).reconcileGroupRouting({
      integrationEventId:req.params.integrationEventId,
    }));
  }));

  router.post('/organizations', platformAction(async (req, res, service, actorReference) => {
    const organization = await service.createOrganization({
      organizationCode: req.body.organizationCode,
      displayName: req.body.displayName,
      organizationType: req.body.organizationType || 'external_care_center',
      actorReference,
    });
    res.status(201).json({ organization });
  }));

  router.get('/organizations/:organizationId/centers', platformAction(async (req, res, service) => {
    res.json({ centers: await service.listOrganizationCenters(req.params.organizationId) });
  }));

  router.get('/centers/:centerId/organization', platformAction(async (req, res, service) => {
    const organization = await service.getOrganizationForCenter(req.params.centerId);
    if (!organization) return res.status(404).json({ error: 'not_found', errorCode: 'CENTER_ORGANIZATION_NOT_FOUND' });
    return res.json({ organization });
  }));

  router.patch('/centers/:centerId/organization', platformAction(async (req, res, service, actorReference) => {
    const organization = await service.relinkCenter({
      centerId: req.params.centerId, organizationId: req.body.organizationId, actorReference,
    });
    res.json({ organization });
  }));

  router.get('/centers/:centerId/capabilities', platformAction(async (req, res, service) => {
    res.json({ capabilities: await service.listCenterCapabilities(req.params.centerId) });
  }));

  router.get('/centers/:centerId/resident-options', platformAction(async (req, res, service) => {
    res.json({ residents: await service.listCenterResidentOptions(req.params.centerId, {
      search: req.query.search || null,
      limit: req.query.limit,
    }) });
  }));

  router.patch('/centers/:centerId/capabilities/:capabilityKey', platformAction(async (req, res, service, actorReference) => {
    const capability = await service.setCenterCapability({
      centerId: req.params.centerId, capabilityKey: req.params.capabilityKey,
      enabled: req.body.enabled, actorReference,
    });
    res.json({ capability });
  }));

  router.get('/organizations/:organizationId/integration-clients', platformAction(async (req, res, service) => {
    res.json({ integrationClients: await service.listIntegrationClients(req.params.organizationId) });
  }));

  router.get('/integration-clients', platformAction(async (req, res, service) => {
    res.json(await service.listIntegrationClientDirectory({
      search:req.query.search, status:req.query.status, page:req.query.page, limit:req.query.limit,
    }));
  }));

  router.post('/organizations/:organizationId/integration-clients', platformAction(async (req, res, service, actorReference) => {
    const body = req.body || {};
    assertBodyKeys(body, ['clientCode', 'displayName', 'sourceSystem', 'initialStatus']);
    const integrationClient = await service.createIntegrationClient({
      organizationId: req.params.organizationId, clientCode: body.clientCode,
      displayName: body.displayName, sourceSystem: body.sourceSystem,
      initialStatus: body.initialStatus || 'active',
      actorReference,
    });
    res.status(201).json({ integrationClient });
  }));

  router.get('/integration-clients/:integrationClientId', platformAction(async (req, res, service) => {
    res.json({ integrationClient: await service.inspectIntegrationClient(req.params.integrationClientId) });
  }));

  router.patch('/integration-clients/:integrationClientId/identity-resolution-policy', platformAction(async (req, res, service, actorReference) => {
    const body = req.body || {};
    assertBodyKeys(body, ['identityResolutionMode', 'unresolvedEventPolicy', 'familyGroupRequirement']);
    res.json({ policy:await service.setIdentityResolutionPolicy({
      integrationClientId:req.params.integrationClientId, policy:body, actorReference,
    }) });
  }));

  router.patch('/integration-clients/:integrationClientId/status', platformAction(async (req, res, service, actorReference) => {
    const body = req.body || {}; assertBodyKeys(body, ['status']);
    res.json({ integrationClient: await service.setIntegrationClientStatus({
      integrationClientId:req.params.integrationClientId, status:body.status, actorReference,
    }) });
  }));

  router.post('/integration-clients/:integrationClientId/revoke', platformAction(async (req, res, service, actorReference) => {
    res.json({ integrationClient: await service.revokeIntegrationClient({
      integrationClientId: req.params.integrationClientId, actorReference,
    }) });
  }));

  router.put('/integration-clients/:integrationClientId/centers/:centerId', platformAction(async (req, res, service, actorReference) => {
    res.json(await service.addClientCenterScope({
      integrationClientId: req.params.integrationClientId,
      centerId: req.params.centerId, actorReference,
    }));
  }));

  router.delete('/integration-clients/:integrationClientId/centers/:centerId', platformAction(async (req, res, service, actorReference) => {
    res.json(await service.removeClientCenterScope({
      integrationClientId: req.params.integrationClientId,
      centerId: req.params.centerId, actorReference,
    }));
  }));

  router.put('/integration-clients/:integrationClientId/event-scopes/:eventType', platformAction(async (req, res, service, actorReference) => {
    res.json(await service.addClientEventScope({
      integrationClientId: req.params.integrationClientId,
      eventType: req.params.eventType, actorReference,
    }));
  }));

  router.delete('/integration-clients/:integrationClientId/event-scopes/:eventType', platformAction(async (req, res, service, actorReference) => {
    res.json(await service.removeClientEventScope({
      integrationClientId: req.params.integrationClientId,
      eventType: req.params.eventType, actorReference,
    }));
  }));

  router.post('/integration-clients/:integrationClientId/credentials', platformAction(async (req, res, service, actorReference) => {
    assertBodyKeys(req.body, []);
    const result = await service.issueCredential({
      integrationClientId: req.params.integrationClientId, actorReference,
    });
    res.status(201).json({ ...result, warning: 'Secret แสดงครั้งเดียว โปรดจัดเก็บในระบบจัดการ Secret ที่ปลอดภัย' });
  }));

  router.post('/integration-clients/:integrationClientId/credentials/:credentialId/rotate', platformAction(async (req, res, service, actorReference) => {
    const body = req.body || {}; assertBodyKeys(body, ['overlapSeconds']);
    const result = await service.rotateCredential({
      integrationClientId: req.params.integrationClientId,
      credentialId: req.params.credentialId,
      overlapSeconds: body.overlapSeconds || 0,
      actorReference,
    });
    res.status(201).json({ ...result, warning: 'Secret ใหม่แสดงครั้งเดียว' });
  }));

  router.post('/integration-clients/:integrationClientId/credentials/:credentialId/revoke', platformAction(async (req, res, service, actorReference) => {
    assertBodyKeys(req.body, []);
    res.json({ credential: await service.revokeCredential({
      integrationClientId: req.params.integrationClientId,
      credentialId: req.params.credentialId, actorReference,
    }) });
  }));

  router.put('/integration-clients/:integrationClientId/external-centers/:externalCenterId', platformAction(async (req, res, service, actorReference) => {
    const body = req.body || {}; assertBodyKeys(body, ['centerId', 'displayName']);
    res.json({ mapping: await service.mapExternalCenter({
      integrationClientId: req.params.integrationClientId,
      externalCenterId: req.params.externalCenterId,
      centerId: body.centerId, displayName: body.displayName, actorReference,
    }) });
  }));

  router.get('/integration-clients/:integrationClientId/external-centers', platformAction(async (req, res, service) => {
    res.json(await service.listExternalCenterMappings(req.params.integrationClientId, {
      status:req.query.status || null, search:req.query.search || null,
      page:req.query.page, limit:req.query.limit,
    }));
  }));

  router.delete('/integration-clients/:integrationClientId/external-centers/:externalCenterId', platformAction(async (req, res, service, actorReference) => {
    res.json({ mapping: await service.deactivateExternalCenterMapping({
      integrationClientId: req.params.integrationClientId,
      externalCenterId: req.params.externalCenterId, actorReference,
    }) });
  }));

  router.put('/integration-clients/:integrationClientId/external-centers/:externalCenterId/subjects/:externalResidentId', platformAction(async (req, res, service, actorReference) => {
    const body = req.body || {}; assertBodyKeys(body, ['residentId', 'firstName', 'lastName', 'displayName', 'room']);
    res.json({ mapping: await service.mapExternalSubject({
      integrationClientId: req.params.integrationClientId,
      externalCenterId: req.params.externalCenterId,
      externalResidentId: req.params.externalResidentId,
      residentId: body.residentId || null,
      firstName: body.firstName, lastName: body.lastName,
      displayName: body.displayName, room: body.room,
      actorReference,
    }) });
  }));

  router.get('/integration-clients/:integrationClientId/external-subjects', platformAction(async (req, res, service) => {
    res.json(await service.listExternalSubjectMappings(req.params.integrationClientId, {
      status:req.query.status || null, search:req.query.search || null,
      page:req.query.page, limit:req.query.limit,
    }));
  }));

  router.delete('/integration-clients/:integrationClientId/external-centers/:externalCenterId/subjects/:externalResidentId', platformAction(async (req, res, service, actorReference) => {
    res.json({ mapping: await service.deactivateExternalSubjectMapping({
      integrationClientId: req.params.integrationClientId,
      externalCenterId: req.params.externalCenterId,
      externalResidentId: req.params.externalResidentId,
      actorReference,
    }) });
  }));

  return router;
}

module.exports = { createPlatformAdminRouter, sendPlatformError, assertBodyKeys };
