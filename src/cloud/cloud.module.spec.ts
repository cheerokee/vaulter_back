import { ConfigService } from '@nestjs/config';
import { createLanguageModel } from './cloud.module.js';
import { BedrockLanguageModel } from './infra/bedrock/bedrock-language-model.js';
import { OpenRouterLanguageModel } from './infra/openrouter/openrouter-language-model.js';
import { FakeLanguageModel } from './testing/fake-language-model.js';

const base = {
  AWS_REGION: 'us-east-1',
  CLOUD_LLM_MODEL_ID: 'us.anthropic.claude-sonnet-5-5',
};

describe('createLanguageModel', () => {
  it('picks the driver', () => {
    expect(
      createLanguageModel(
        new ConfigService({ ...base, CLOUD_LLM_DRIVER: 'fake' }),
      ),
    ).toBeInstanceOf(FakeLanguageModel);
    expect(
      createLanguageModel(
        new ConfigService({ ...base, CLOUD_LLM_DRIVER: 'bedrock' }),
      ),
    ).toBeInstanceOf(BedrockLanguageModel);
    expect(
      createLanguageModel(
        new ConfigService({
          ...base,
          CLOUD_LLM_DRIVER: 'openrouter',
          OPENROUTER_API_KEY: 'sk-or-test',
        }),
      ),
    ).toBeInstanceOf(OpenRouterLanguageModel);
  });

  it('refuses the fake and openrouter in production', () => {
    for (const driver of ['fake', 'openrouter']) {
      expect(() =>
        createLanguageModel(
          new ConfigService({
            ...base,
            CLOUD_LLM_DRIVER: driver,
            OPENROUTER_API_KEY: 'sk-or-test',
            NODE_ENV: 'production',
          }),
        ),
      ).toThrow(/production/);
    }
  });
});
