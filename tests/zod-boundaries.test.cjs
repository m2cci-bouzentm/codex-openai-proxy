const { test } = require('node:test');
const assert = require('node:assert/strict');

test('Zod boundary schemas reject malformed/nested/unknown input and validate live payload contracts', async () => {
  // Test dynamic import of schemas from built dist/
  const authSchema = require('../dist/schemas/auth.schema');
  const configSchema = require('../dist/schemas/config.schema');
  const openaiSchema = require('../dist/schemas/openai.schema');
  const anthropicSchema = require('../dist/schemas/anthropic.schema');
  const providerSchema = require('../dist/schemas/provider.schema');

  // 1. Auth schemas
  assert.ok(authSchema.oauthEntrySchema);
  assert.ok(authSchema.authStatusSchema);
  assert.ok(authSchema.tokenWizardInputSchema);

  // Valid OAuth Entry
  const validEntry = {
    type: 'oauth',
    access: 'valid-access',
    refresh: 'valid-refresh',
    expires: 1700000000000,
    accountId: 'acc-123',
    subscriptionType: 'plus',
    rateLimitTier: 'tier-1',
    scopes: ['user:profile']
  };
  assert.doesNotThrow(() => authSchema.oauthEntrySchema.parse(validEntry));

  // Invalid OAuth Entry - bad type or missing tokens
  assert.throws(() => authSchema.oauthEntrySchema.parse({ type: 'not-oauth' }));
  assert.throws(() => authSchema.oauthEntrySchema.parse({ type: 'oauth', access: '', refresh: '' }));

  // Wizard input validation
  assert.throws(() => authSchema.tokenWizardInputSchema.parse({ access: '', refresh: '', expires: '', accountId: '' }));

  // 2. Config schema
  assert.ok(configSchema.envConfigSchema);
  const parsedConfig = configSchema.envConfigSchema.parse({});
  assert.equal(parsedConfig.PORT, 3033);
  assert.equal(parsedConfig.CODEX_TIMEOUT_MS, 120000);

  // 3. OpenAI request schema
  assert.ok(openaiSchema.chatCompletionRequestSchema);
  const validOpenAI = {
    model: 'gpt-5.6-sol',
    messages: [{ role: 'user', content: 'hello' }],
    temperature: 0.7,
    stream: false,
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          }
        }
      }
    ]
  };
  const parsedReq = openaiSchema.chatCompletionRequestSchema.parse(validOpenAI);
  assert.equal(parsedReq.messages[0].role, 'user');

  // Reject unsupported legacy fields
  assert.throws(() => openaiSchema.chatCompletionRequestSchema.parse({
    model: 'test',
    messages: [{ role: 'user', content: 'hi' }],
    functions: [{ name: 'old' }]
  }));
  assert.throws(() => openaiSchema.chatCompletionRequestSchema.parse({
    model: 'test',
    messages: [{ role: 'user', content: 'hi' }],
    n: 2
  }));

  // 4. Anthropic request schema
  assert.ok(anthropicSchema.messagesRequestSchema);
  const validAnthropic = {
    model: 'gpt-5.6-sol',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'hello' }]
  };
  assert.doesNotThrow(() => anthropicSchema.messagesRequestSchema.parse(validAnthropic));

  // Reject missing max_tokens or non-positive
  assert.throws(() => anthropicSchema.messagesRequestSchema.parse({
    model: 'gpt-5.6-sol',
    max_tokens: 0,
    messages: [{ role: 'user', content: 'hello' }]
  }));

  // 5. Provider response schema
  assert.ok(providerSchema.providerResponseSchema);
  assert.ok(providerSchema.modelsResponseSchema);
  const validModelCatalog = {
    models: [
      { slug: 'gpt-6-astra', display_name: 'GPT-6 Astra', context_window: 272000 }
    ]
  };
  assert.doesNotThrow(() => providerSchema.modelsResponseSchema.parse(validModelCatalog));
  assert.doesNotThrow(() => providerSchema.providerResponseSchema.parse({
    id: 'resp-live-shape', status: 'in_progress', output: [], usage: null, incomplete_details: null,
  }));
});

test('accepted OpenAI sampling fields are not forwarded to Codex upstream', () => {
  const { prepareChat } = require('../dist/services/openai.service');
  const prepared = prepareChat({
    model: 'gpt-5.6-luna',
    messages: [{ role: 'user', content: 'hello' }],
    temperature: 0.2,
    top_p: 0.9,
  });
  assert.equal(prepared.native.temperature, undefined);
  assert.equal(prepared.native.top_p, undefined);
});
