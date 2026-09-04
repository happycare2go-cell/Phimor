# PHIMOR OpenAI V1 + Center Ownership Transfer release

This runbook prepares one reviewed Backend/System Admin/Pharmacist LIFF release.
Center Ownership Transfer is operational. Pharmacist Clinical Research is now
commissioned in `controlled_live` under the separately recorded Standard
Retention production decision. This historical release runbook is retained for
traceability; the current operating posture is authoritative in
`PHIMOR_OPENAI_CLINICAL_RESEARCH_COMMISSIONING.md`.

## Initial environment matrix

| Variable | Initial value/status | Classification |
| --- | --- | --- |
| `NODE_ENV` | `production` | Required for deploy |
| `AI_PROVIDER` | `gemini` | Required for deploy; preserves document/Lab/Plus/explanation AI |
| `GEMINI_API_KEY` | existing server secret | Required for existing Gemini flows |
| `AI_PROVIDER_PHARMACIST` | `openai` | Required for the fast Pharmacist Assistant route |
| `AI_PROVIDER_CLINICAL_RESEARCH` | `openai` | Required for deploy; independent routing |
| `PHARMACIST_AI_RESEARCH_ENABLED` | `true` | Current product state; `false` remains the emergency kill switch |
| `PHARMACIST_AI_RESEARCH_MODE` | `controlled_live` | Uses existing pharmacist and assigned-case authorization |
| `AI_MODEL_DOCUMENT` | `gpt-5.6-luna` | Safe server config; used only when OpenAI owns that purpose |
| `AI_MODEL_EXPLANATION` | `gpt-5.6-terra` | Safe server config; used only when OpenAI owns that purpose |
| `AI_MODEL_PHARMACIST` | `gpt-5.6-terra` | Safe server config; used only when OpenAI owns that purpose |
| `AI_MODEL_CLINICAL_RESEARCH` | `gpt-5.6-sol` | Required before OpenAI preflight |
| `OPENAI_API_KEY` | server secret | Required before using the Pharmacist Assistant OpenAI route, OpenAI preflight, or Clinical Research |
| `PDF_DOWNLOAD_SECRET` | existing server secret | Required for deploy/readiness |
| `OPENAI_CLINICAL_ALLOWED_DOMAINS` | reviewed allowlist or safe built-in default | Optional before deploy; review before enabling Clinical Research |

Never copy secret values into Git, LIFF runtime config, URLs, API responses, or
logs. A disabled Clinical Research feature does not require OpenAI for backend
readiness. Enabling the feature without the credential for its configured
provider makes readiness report a safe configuration issue.

## Controlled release order

1. Human reviews the current HEAD.
2. Confirm the working tree is clean.
3. Confirm production migration status is expected through 0017; stop on a
   checksum mismatch or any unexpected pending migration.
4. Confirm the live backend uses `preDeployCommand: npm run migrate` from the
   reviewed Blueprint.
5. Configure the server-only `OPENAI_API_KEY` without revealing its value.
6. Confirm the reviewed commissioning decision and retain
   `PHARMACIST_AI_RESEARCH_ENABLED=false` until the same-SHA deploy is healthy.
7. Keep document/Lab/Plus/explanation AI on `AI_PROVIDER=gemini`; route only
   the Pharmacist Assistant through `AI_PROVIDER_PHARMACIST=openai`.
8. Push the reviewed HEAD.
9. Deploy Backend and LIFF from the same SHA.
10. The Render pre-deploy step applies 0018 before the new backend starts.
11. Verify the deployed SHA.
12. Verify migration status reports 0018 applied and no checksum mismatch.
13. Verify `/ready` passes.
14. Verify normal Family, Center, System Admin, Pharmacist, and existing Gemini
    flows without sending live AI research requests.
15. Verify the Ownership Transfer admin-safe/synthetic flow as authorized.
16. Run `npm run preflight:openai-v1`; it accepts no input and uses no PHI.
17. Review API usage and cost from the bounded preflight output.
18. Confirm Standard Retention is the accepted current posture, Data Sharing
    remains off, `store:false` remains set, and ZDR is not claimed.
19. Set `PHARMACIST_AI_RESEARCH_MODE=controlled_live` and enable the feature.
20. Verify one authorized pharmacist case with human review and no auto-send.
21. Any broader `AI_PROVIDER=openai` cutover remains a separate future decision.

## Stop conditions

Stop on backup uncertainty, migration checksum/version mismatch, a failed
pre-deploy migration, wrong deployment SHA, `/ready` failure, unexpected
ordinary-provider routing, exposed secret/identifier/content, failed ownership
authorization, non-allowlisted research source, or any pressure to use real PHI
before the governance decision. Do not repair production data ad hoc.
