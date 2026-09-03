# PHIMOR OpenAI AI Provider V1

## Purpose and activation boundary

OpenAI is an optional implementation of the existing PHIMOR AI provider contract. Existing Gemini behavior remains available. Global routing is explicit through `AI_PROVIDER`; the Pharmacist Assistant and Clinical Research can select independent server-side providers through `AI_PROVIDER_PHARMACIST` and `AI_PROVIDER_CLINICAL_RESEARCH`. There is no automatic failure fallback, because silently moving clinical content between providers would weaken cost, privacy, and incident boundaries.

This release does not activate OpenAI in production. Before activation, PHIMOR must complete its privacy, security, DPA, data-residency, retention, and Zero Data Retention (ZDR) governance review. Every Responses API request sets `store:false`, but that request setting is not a claim that the account has ZDR or that all provider-side processing/retention is eliminated.

## Architecture

`AIProviderFactory` selects a provider and model purpose. Both providers expose `generateStructured()`, so current document, explanation, Plus, doctor-question, and pharmacist-assistant services retain their service contracts. Provider-specific model selection prevents `gpt-*` model names configured for later OpenAI use from being sent to Gemini; legacy explicit `gemini-*` model values remain supported.

OpenAI requests use the fixed server-side endpoint `https://api.openai.com/v1/responses`. The browser never receives the API key and cannot select an arbitrary endpoint. The provider supports:

- text and inline JPEG/PNG/WebP image input;
- strict JSON Schema output through the Responses API `text.format` contract;
- local validation after provider output, including exact-object checks where the domain requires them;
- bounded timeout and retry behavior using the existing safe AI error contract;
- optional web search only when the calling service explicitly supplies a bounded search policy;
- safe usage metadata and actual provider citations returned separately from the structured result.

Unknown fields, malformed JSON, refusal/incomplete responses, invalid schemas, non-HTTPS citations, and unsafe response shapes fail closed. Raw provider responses, prompts, image bytes, patient content, API keys, and arbitrary provider error text are not logged or returned to ordinary clients.

## Model routing

| Purpose | Environment variable | Default when OpenAI is selected |
| --- | --- | --- |
| Document/image extraction | `AI_MODEL_DOCUMENT` | `gpt-5.6-luna` |
| Explanation and organization | `AI_MODEL_EXPLANATION` | `gpt-5.6-terra` |
| Pharmacist assistant | `AI_MODEL_PHARMACIST` | `gpt-5.6-terra` |
| Pharmacist Clinical Research | `AI_MODEL_CLINICAL_RESEARCH` | `gpt-5.6-sol` |

Reasoning effort is independently bounded by `AI_REASONING_DOCUMENT`, `AI_REASONING_EXPLANATION`, `AI_REASONING_PHARMACIST`, and `AI_REASONING_CLINICAL_RESEARCH`. Supported configured values are `low`, `medium`, and `high`; invalid values fall back to the safe purpose default.

## Configuration

Required to select OpenAI for all globally routed AI flows:

- `AI_PROVIDER=openai`
- `OPENAI_API_KEY` as a server-side secret

The production routing target keeps `AI_PROVIDER=gemini` for document, Lab,
Plus, and explanation flows; sets `AI_PROVIDER_PHARMACIST=openai` for the fast
Pharmacist Assistant; and sets `AI_PROVIDER_CLINICAL_RESEARCH=openai` for the
deeper research workflow. When either purpose-specific override is absent, it
falls back to `AI_PROVIDER`. Provider failure never causes cross-provider
fallback.

Optional controls:

- the four model variables above;
- the four reasoning variables above;
- `AI_TIMEOUT_MS` (bounded by configuration validation);
- `AI_TIMEOUT_PHARMACIST_MS` (recommended production value `45000`, bounded to 5–120 seconds, with `AI_TIMEOUT_MS` as the compatibility fallback when absent);
- `AI_TIMEOUT_CLINICAL_RESEARCH_MS` (recommended production value `90000`, bounded to 5–120 seconds, with `AI_TIMEOUT_MS` as the compatibility fallback when absent, and applied to each planner, evidence, and synthesis provider call);
- `AI_MAX_RETRIES` (bounded by configuration validation);
- `OPENAI_CLINICAL_ALLOWED_DOMAINS` for Clinical Research only.

Provider retries share one bounded overall deadline. The first attempt receives
that full deadline rather than a fraction of it. A retry can occur only after an
early retryable failure and uses only the time still remaining; a request that
exhausts the deadline cannot start another full-duration attempt.

Readiness reports safe issue codes when an active globally routed flow or the
Pharmacist Assistant selects OpenAI without a key. Disabled Clinical Research
does not by itself require an OpenAI key; if enabled, readiness requires the
credential for its configured provider. Readiness never projects a key or its
value. Gemini configuration and behavior are unchanged for purposes still
routed by `AI_PROVIDER=gemini`.

## Structured output and compatibility

The provider sends a strict JSON Schema when a task has a schema, parses the returned output text, and then applies PHIMOR's existing local validator. Provider schema validation does not replace domain validation. Existing document and medication compatibility—including older medication `{name, dose, condition}` results and optional richer medication fields—remains controlled by the shared local validators.

Inline source images are request inputs only. V1 does not introduce a permanent OpenAI image archive. Existing PHIMOR authorization, upload limits, magic-byte verification, source-image retention, and clinical human-review boundaries continue to apply.

## Usage and audit metadata

The provider exposes nullable, nonnegative `inputTokens`, `outputTokens`, `totalTokens`, and `reasoningTokens`, plus web-search call count and safe source metadata. `NULL` means the provider did not report a value; `0` means an authoritative zero. PHIMOR does not double-add reasoning tokens to a provider-reported total.

`ai_interaction_audit` stores operational metadata only: identity/purpose references already allowed by the audit design, provider/model/prompt versions, timestamps/status, bounded character counts, usage counts, research flags, and source count. It never stores prompts, conversations, clinical facts, medication/lab values, images, search queries, web excerpts, generated analysis, or draft replies.

## Known limitations

- Automated tests use mocked provider responses; they do not prove production credentials, account policy, latency, or model availability.
- `store:false` is necessary but not sufficient for PHIMOR's ZDR/DPA approval.
- OpenAI states that API data is not used to train models by default, but abuse-monitoring and application-state retention controls remain separate. PHIMOR must verify the applicable contract and project controls rather than infer them from `store:false`.
- OpenAI's current data-controls documentation states that live Web Search with external internet access is not eligible for HIPAA processing under a BAA; its offline/cache-only mode has separate, narrow eligibility conditions. PHIMOR's current Clinical Research design uses live search, so no PHI web-search commissioning is allowed unless PHIMOR governance determines the applicable legal and contractual path.
- Web evidence is not a substitute for a licensed drug-interaction database or a pharmacist's review.
- Model identifiers and account access must be verified during a separately approved, non-PHI commissioning step before any production enablement.

Operator-only, non-PHI capability verification is available through
`npm run preflight:openai-v1`. It accepts no CLI text, uses only hard-coded
synthetic/general prompts, performs no database or LINE operation, and must be
run only after the reviewed deployment and server-side credential setup.
