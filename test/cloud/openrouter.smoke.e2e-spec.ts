import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { Embedder } from '../../src/cloud/application/ports/embedder.js';
import { LanguageModel } from '../../src/cloud/application/ports/language-model.js';
import { OllamaEmbedder } from '../../src/cloud/infra/embeddings/ollama-embedder.js';
import { OpenRouterLanguageModel } from '../../src/cloud/infra/openrouter/openrouter-language-model.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import { openMessage } from '../support/conversation-crypto.js';
import { conversationsKit } from '../support/conversations-kit.js';
import { expectStatus, identityClient } from '../support/identity-client.js';
import { cloudSwitch, simulatedHub } from '../support/space-manifest.js';

/**
 * Smoke test of the cloud responder with a REAL Claude (OpenRouter) and the real embeddings service (Ollama of the
 * compose). Development only: costs a few cents of OpenRouter credit and sends the (fictional) test text to
 * OpenRouter/Anthropic. Skipped unless both variables are set, so CI and `npm run test:e2e` skip it:
 *   docker exec -e OPENROUTER_API_KEY=... -e EMBEDDINGS_REAL_URL=http://embeddings:11434 vaulter-back-app \
 *     npx vitest run -c vitest.config.e2e.ts test/cloud/openrouter.smoke.e2e-spec.ts
 */
const apiKey = process.env.OPENROUTER_API_KEY;
const embeddingsUrl = process.env.EMBEDDINGS_REAL_URL;
const MODEL = 'anthropic/claude-sonnet-5.5';

const enc = (s: string) => new TextEncoder().encode(s);

describe.runIf(apiKey && embeddingsUrl)(
  'the cloud answers with a real Claude through OpenRouter (smoke)',
  { timeout: 180_000 },
  () => {
    let app: INestApplication;
    const c = identityClient(() => app);
    const s = c.spaces;
    const k = conversationsKit(() => app);
    const cloud = cloudSwitch(() => app);
    const sim = simulatedHub(() => app);
    const db = async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
      (await adminDataSource()).query(sql, params);

    const eventually = async (
      check: () => Promise<void>,
      timeoutMs: number,
    ) => {
      const until = Date.now() + timeoutMs;
      for (;;) {
        try {
          await check();
          return;
        } catch (error) {
          if (Date.now() > until) throw error;
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    };

    beforeAll(async () => {
      await resetDatabase();
      app = await createTestApp({
        env: { JOB_WORKERS_ENABLED: 'true' },
        overrides: [
          {
            provide: Embedder,
            useValue: new OllamaEmbedder(
              new ConfigService({
                EMBEDDINGS_URL: embeddingsUrl,
                EMBEDDING_MODEL: 'nomic-embed-text:v1.5',
              }),
            ),
          },
          {
            provide: LanguageModel,
            useValue: new OpenRouterLanguageModel(
              new ConfigService({
                CLOUD_LLM_MODEL_ID: MODEL,
                OPENROUTER_API_KEY: apiKey,
              }),
            ),
          },
        ],
      });
    }, 120_000);

    afterAll(async () => {
      await app?.close();
    });

    it('indexes a test document and answers a question about it', async () => {
      const olivia = await s.signUpKeyed('olivia@example.com', 'Olivia');
      const o = await s.orgWithKit(olivia, 'Casa');
      const created = await s.create(olivia, o.orgId, o.kit.publicKey, 'Farol');
      await expectStatus(Promise.resolve(created.res), 201);
      const spaceId = created.spaceId;
      await cloud.switchOn(olivia, o.orgId, spaceId, [created.key]);

      // Fictional fact, only test data leaves to OpenRouter.
      await sim
        .forSpace(olivia, { spaceId, key: created.key })
        .addFile(
          'Historia do farol.md',
          'text/markdown',
          enc(
            'Historia do Farol de Itapuã-Mirim: em 1987 o farol foi pintado de verde-limão pelo faroleiro Teobaldo Quaresma.',
          ),
        );
      await eventually(async () => {
        const [row] = await db<{ n: number }>(
          `SELECT count(*)::int AS n FROM cloud_chunks WHERE space_id = $1`,
          [spaceId],
        );
        expect(row!.n).toBeGreaterThan(0);
      }, 60_000);

      const serverPublicKey = await s.serverPublicKey(olivia.token);
      const conv = await k.create(olivia, spaceId, { serverPublicKey });
      await expectStatus(Promise.resolve(conv.res), 201);
      const sent = await k.send(olivia, spaceId, conv.id, conv.keys, {
        text: 'Quem pintou o Farol de Itapuã-Mirim, e de que cor?',
        cloudAnswer: true,
      });
      await expectStatus(Promise.resolve(sent.res), 201);

      let answer = '';
      await eventually(async () => {
        const res = await expectStatus(
          request(app.getHttpServer())
            .get('/conversations/changes')
            .query({ since: 0, conversationId: conv.id })
            .set({ Authorization: `Bearer ${olivia.token}` }),
          200,
        );
        const item = (
          res.body.items as {
            type: string;
            deleted: boolean;
            data: Record<string, unknown>;
          }[]
        ).find(
          (i) =>
            i.type === 'conversation_message' &&
            !i.deleted &&
            i.data.authorCloud === true,
        );
        expect(item).toBeDefined();
        const keyVersion = item!.data.keyVersion as number;
        const plain = await openMessage(
          conv.keys[keyVersion - 1]!,
          {
            spaceId,
            conversationId: conv.id,
            recordId: item!.data.id as string,
            keyVersion,
          },
          Buffer.from(item!.data.encryptedBody as string, 'base64url'),
        );
        const raw = new TextDecoder().decode(plain);
        try {
          answer = (JSON.parse(raw) as { text: string }).text;
        } catch {
          answer = raw;
        }
      }, 120_000);

      expect(answer.trim()).not.toBe('');
      expect(answer).toMatch(/Teobaldo/i);

      // Numbers only (never the text).
      const usage = await db<{
        kind: string;
        input_tokens: string;
        output_tokens: string;
        cost_micro_usd: string;
        calls: number;
      }>(
        `SELECT kind, input_tokens::text, output_tokens::text, cost_micro_usd::text, calls
           FROM cloud_ai_usage WHERE space_id = $1 ORDER BY kind`,
        [spaceId],
      );
      for (const u of usage) {
        console.log(
          `[openrouter smoke] ${u.kind}: calls=${u.calls} in=${u.input_tokens} out=${u.output_tokens} cost=US$ ${(Number(u.cost_micro_usd) / 1e6).toFixed(6)}`,
        );
      }
      expect(usage.find((u) => u.kind === 'answer')).toBeDefined();
    });
  },
);
