import { ConfigService } from '@nestjs/config';
import { createLanguageModel } from './cloud.module.js';
import { BedrockLanguageModel } from './infra/bedrock/bedrock-language-model.js';
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
  });

  it('refuses the fake in production', () => {
    expect(() =>
      createLanguageModel(
        new ConfigService({
          ...base,
          CLOUD_LLM_DRIVER: 'fake',
          NODE_ENV: 'production',
        }),
      ),
    ).toThrow(/production/);
  });
});
