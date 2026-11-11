import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Embedder } from '../../src/cloud/application/ports/embedder.js';
import { LanguageModel } from '../../src/cloud/application/ports/language-model.js';
import {
  AnswerConversationJob,
  BUDGET_NOTICE_TEXT,
} from '../../src/cloud/application/responder/answer-conversation.job.js';
import { ResponderClock } from '../../src/cloud/application/responder/responder-clock.js';
import {
  answerIdFor,
  documentObjectIdFor,
} from '../../src/cloud/domain/responder.js';
import { FakeEmbedder } from '../../src/cloud/testing/fake-embedder.js';
import { FakeLanguageModel } from '../../src/cloud/testing/fake-language-model.js';
import { newId } from '../../src/shared/domain/id.js';
import { CloudConversationExecutor } from '../../src/conversations/application/cloud-conversation-executor.js';
import { BackupContentReader } from '../../src/storage/application/backup-content-reader.js';
import { ServerBackupWriter } from '../../src/storage/application/server-backup-writer.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import {
  newConversationKey,
  openMessage,
} from '../support/conversation-crypto.js';
import {
  conversationsKit,
  hubRecipientOf,
  messageRows,
  type ConversationKeys,
} from '../support/conversations-kit.js';
import { hubClient } from '../support/hub-client.js';
import { openBackupObject } from '../support/hub-crypto.js';
import { hubsKit, type ClaimedHub } from '../support/hubs-kit.js';
import {
  expectStatus,
  identityClient,
  recipientOf,
  type KeyedUser,
} from '../support/identity-client.js';
import {
  cloudManifestObjectId,
  cloudSwitch,
  setAiBudgetInDb,
  simulatedHub,
} from '../support/space-manifest.js';

/** The responder's clock (the database's), moved by the spec instead of sleeping 30 s. */
class TestClock {
  offsetMs = 0;
  async now(): Promise<Date> {
    const [row] = (await (
      await adminDataSource()
    ).query(`SELECT clock_timestamp() AS now`)) as { now: Date }[];
    return new Date(row!.now.getTime() + this.offsetMs);
  }
}

type FeedItem = {
  type: string;
  deleted: boolean;
  data: Record<string, unknown>;
};
type Decoded = Record<string, unknown> & { text: string };

const enc = (s: string) => new TextEncoder().encode(s);

// Responder e documentar pela nuvem (spec active-cloud §4.3; Task 7 do plano), ponta a ponta: HTTP real, cifra real do
// app/Hub, chave do servidor no KMS do LocalStack, backup no S3 do LocalStack, workers do pg-boss ligados; o modelo de
// linguagem e o embedder são os falsos determinísticos (DI) e o relógio do executor é controlado (não espera 30 s).
// Review Focus 2 (Hub primeiro; o ack decide) e 5 (nunca conversas alheias).
describe(
  'the cloud answers and documents (e2e, workers on)',
  { timeout: 60_000 },
  () => {
    let app: INestApplication;
    const llm = new FakeLanguageModel();
    const embedder = new FakeEmbedder();
    const clock = new TestClock();
    const c = identityClient(() => app);
    const s = c.spaces;
    const h = hubClient(() => app);
    const hubs = hubsKit(() => app);
    const k = conversationsKit(() => app);
    const cloud = cloudSwitch(() => app);
    const sim = simulatedHub(() => app);
    const http = () => request(app.getHttpServer());
    const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

    let olivia: KeyedUser; // admin, Gestora do espaço, dona do Hub "casa"
    let ana: KeyedUser; // editora
    let bruno: KeyedUser; // leitor
    let orgId: string;
    let active: string;
    let spaceKey: Uint8Array;
    let casa: ClaimedHub;
    let casaToken: string;
    let serverPk: string;

    const db = async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
      (await adminDataSource()).query(sql, params);

    const eventually = async (
      check: () => Promise<void>,
      timeoutMs = 30_000,
    ) => {
      const until = Date.now() + timeoutMs;
      for (;;) {
        try {
          await check();
          return;
        } catch (error) {
          if (Date.now() > until) throw error;
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    };

    /** A conversation in the active space (with the reserve), optionally with the Hub as executor and more people. */
    const conversation = async (
      owner: KeyedUser,
      opts: { executor?: boolean; with?: KeyedUser[] } = {},
    ) => {
      const conv = await k.create(owner, active, {
        serverPublicKey: serverPk,
        ...(opts.executor ? { executor: hubRecipientOf(casa) } : {}),
      });
      await expectStatus(Promise.resolve(conv.res), 201);
      if (opts.with?.length) {
        await expectStatus(
          k.share(
            owner,
            active,
            conv.id,
            opts.with.map(recipientOf),
            conv.keys,
          ),
          200,
        );
      }
      return { id: conv.id, keys: conv.keys };
    };

    const send = async (
      user: KeyedUser,
      conv: { id: string; keys: ConversationKeys },
      text: string,
      opts: { cloudAnswer?: boolean } = {},
    ) => {
      const sent = await k.send(user, active, conv.id, conv.keys, {
        text,
        ...opts,
      });
      await expectStatus(Promise.resolve(sent.res), 201);
      return sent.id;
    };

    /** The conversation's messages from a participant's feed, decrypted with the conversation key. */
    const messagesOf = async (
      user: KeyedUser,
      conv: { id: string; keys: ConversationKeys },
    ) => {
      const res = await expectStatus(
        http()
          .get('/conversations/changes')
          .query({ since: 0, conversationId: conv.id })
          .set(bearer(user.token)),
        200,
      );
      const items = (res.body.items as FeedItem[]).filter(
        (i) => i.type === 'conversation_message' && !i.deleted,
      );
      return Promise.all(
        items.map(async (i) => {
          const keyVersion = i.data.keyVersion as number;
          const plain = await openMessage(
            conv.keys[keyVersion - 1]!,
            {
              spaceId: active,
              conversationId: conv.id,
              recordId: i.data.id as string,
              keyVersion,
            },
            Buffer.from(i.data.encryptedBody as string, 'base64url'),
          );
          const raw = new TextDecoder().decode(plain);
          let decoded: Decoded;
          try {
            decoded = JSON.parse(raw) as Decoded;
          } catch {
            decoded = { text: raw };
          }
          return { ...i.data, decoded } as Record<string, unknown> & {
            id: string;
            authorCloud: boolean;
            pending: boolean;
            ackedByCloud: boolean;
            cloudAnswerRequested: boolean;
            decoded: Decoded;
          };
        }),
      );
    };
    const cloudMessages = async (
      user: KeyedUser,
      conv: { id: string; keys: ConversationKeys },
    ) => (await messagesOf(user, conv)).filter((m) => m.authorCloud);

    const runJob = (conversationId: string) =>
      app
        .get(AnswerConversationJob)
        .run({ organizationId: orgId, spaceId: active, conversationId });

    const waitingJobs = (conversationId: string) =>
      db<{ delay: number }>(
        `SELECT EXTRACT(EPOCH FROM start_after - created_on)::float8 AS delay
         FROM pgboss.job
        WHERE name = 'cloud.answer-conversation' AND data->>'conversationId' = $1 AND state = 'created'`,
        [conversationId],
      );
    const openJobs = async (conversationId: string) =>
      (
        await db<{ n: number }>(
          `SELECT count(*)::int AS n FROM pgboss.job
          WHERE name = 'cloud.answer-conversation' AND data->>'conversationId' = $1
            AND state IN ('created', 'retry', 'active') AND start_after <= now()`,
          [conversationId],
        )
      )[0]!.n;
    const answerReservations = async () =>
      (
        await db<{ n: number }>(
          `SELECT count(*)::int AS n FROM cloud_ai_reservations WHERE organization_id = $1 AND kind = 'answer'`,
          [orgId],
        )
      )[0]!.n;

    /** Live version of a backup object of the space, opened with the space key (what a member or the Hub would see). */
    const backupPlaintext = async (objectId: string) => {
      const reader = app.get(BackupContentReader);
      const v = (await reader.liveVersions(orgId, active, [objectId])).get(
        objectId,
      );
      if (!v) return null;
      const blob = await reader.read(orgId, active, v, 10 * 1024 * 1024);
      return new TextDecoder().decode(
        await openBackupObject(
          spaceKey,
          { spaceId: active, objectId, keyVersion: v.keyVersion },
          blob,
        ),
      );
    };

    beforeAll(async () => {
      await resetDatabase();
      app = await createTestApp({
        env: { JOB_WORKERS_ENABLED: 'true' },
        overrides: [
          { provide: Embedder, useValue: embedder },
          { provide: LanguageModel, useValue: llm },
          { provide: ResponderClock, useValue: clock },
        ],
      });
      olivia = await s.signUpKeyed('olivia@example.com', 'Olivia');
      ana = await s.signUpKeyed('ana@example.com', 'Ana');
      bruno = await s.signUpKeyed('bruno@example.com', 'Bruno');
      const o = await s.orgWithKit(olivia, 'Casa');
      orgId = o.orgId;
      for (const u of [ana, bruno]) await s.joinOrg(olivia, orgId, u);
      casa = await h.onboard(olivia.token, 'Casa');
      await hubs.link(olivia, casa.hubId, orgId);
      casaToken = await h.authenticate(casa);

      const a = await s.create(olivia, orgId, o.kit.publicKey, 'Ativo');
      await expectStatus(Promise.resolve(a.res), 201);
      active = a.spaceId;
      spaceKey = a.key;
      for (const [u, role] of [
        [ana, 'space_editor'],
        [bruno, 'space_reader'],
      ] as const) {
        await expectStatus(
          s.addMember(olivia.token, active, recipientOf(u), [spaceKey], role),
          201,
        );
      }
      await hubs.addSpace(olivia, casa.hubId, active);
      serverPk = await s.serverPublicKey(olivia.token);
      await cloud.switchOn(olivia, orgId, active, [spaceKey]);
      // A document of the space (the simulated Hub), indexed by the workers.
      await sim
        .forSpace(olivia, { spaceId: active, key: spaceKey })
        .addFile(
          'Manual de compras.md',
          'text/markdown',
          enc(
            'Manual de compras: para aprovar uma compra urgente, o gestor assina no Orion em Compras e depois Aprovar.',
          ),
        );
      await eventually(async () => {
        const [row] = await db<{ n: number }>(
          `SELECT count(*)::int AS n FROM cloud_chunks WHERE space_id = $1`,
          [active],
        );
        expect(row!.n).toBeGreaterThan(0);
      });
    }, 240_000);

    afterAll(async () => {
      await app?.close();
    });

    afterEach(() => {
      clock.offsetMs = 0;
    });

    describe('Hub first (Review Focus 2)', () => {
      it('Hub away: the job waits 30 s; then (controlled clock) the cloud answers, the message is acked by it and the Hub’s late ack is 404', async () => {
        const conv = await conversation(olivia, { executor: true });
        const question = await send(
          olivia,
          conv,
          'Como aprovar uma compra urgente?',
        );
        // Scheduled 30 s after the message (CLOUD_FALLBACK_AFTER_MS), not now.
        const [job] = await waitingJobs(conv.id);
        expect(job!.delay).toBeGreaterThanOrEqual(29);
        expect(job!.delay).toBeLessThanOrEqual(31);

        // Run early: still the Hub's (nothing taken, no model call).
        const calls = llm.calls.length;
        await runJob(conv.id);
        expect(llm.calls.length).toBe(calls);
        expect(
          (await messageRows(conv.id)).find((m) => m.id === question)!.pending,
        ).toBe(true);

        clock.offsetMs = 31_000;
        await runJob(conv.id);
        const messages = await messagesOf(olivia, conv);
        const q = messages.find((m) => m.id === question)!;
        expect(q.pending).toBe(false);
        expect(q.ackedByCloud).toBe(true);
        const answer = messages.find((m) => m.authorCloud)!;
        expect(answer.id).toBe(answerIdFor(question));
        expect(answer.decoded.text).toBe(
          'fake answer: Como aprovar uma compra urgente?',
        );
        // Context: the space's chunk (retrieval) and the audience; versioned Antares prompt.
        const call = llm.calls[llm.calls.length - 1]!;
        expect(call.system).toContain('Manual de compras');
        expect(call.system).toContain('Compras e depois Aprovar');
        expect(call.system).toContain(
          '3 pessoas (1 Editor, 1 Gestor, 1 Leitor)',
        );
        expect(call.tools?.map((t) => t.name)).toEqual([
          'propose_document',
          'record_document',
        ]);

        // The Hub comes back: the message is the cloud's, its ack is 404 (it must not execute it).
        const ack = await k.hubAck(casaToken, conv.id, question);
        expect(ack.status).toBe(404);
        expect(String(ack.body.type)).toMatch(/\/message-not-found$/);

        // Running again does nothing (answered: idempotent by the derived answer id).
        await runJob(conv.id);
        expect((await cloudMessages(olivia, conv)).length).toBe(1);
      });

      it('one waiting job per conversation: two messages and an early run never add a second job (keyed queue)', async () => {
        const conv = await conversation(olivia, { executor: true });
        await send(olivia, conv, 'primeira');
        const [first] = await waitingJobs(conv.id);
        await send(olivia, conv, 'segunda');
        await runJob(conv.id); // early: reschedules (still the Hub's)
        const jobs = await waitingJobs(conv.id);
        expect(jobs).toHaveLength(1);
        // Never postponed by the later message: still the first message's 30 s.
        expect(jobs[0]!.delay).toBeLessThanOrEqual(first!.delay + 1);
        const [queue] = await db<{ policy: string }>(
          `SELECT policy FROM pgboss.queue WHERE name = 'cloud.answer-conversation'`,
        );
        expect(queue!.policy).toBe('stately');
      });

      it('a message requeued to a new executor Hub gets the new Hub its own 30 s (counted from the requeue, database clock)', async () => {
        const escritorio = await h.onboard(olivia.token, 'Escritorio');
        await hubs.link(olivia, escritorio.hubId, orgId);
        await hubs.addSpace(olivia, escritorio.hubId, active);
        const conv = await conversation(olivia, { executor: true });
        const question = await send(olivia, conv, 'o Hub da casa pegou esta');
        await expectStatus(k.hubAck(casaToken, conv.id, question), 200);
        await new Promise((r) => setTimeout(r, 3_000));
        // The owner moves the conversation to the other Hub: the message goes back to the queue (and the key rotates).
        await expectStatus(
          k.changeExecutor(
            olivia,
            active,
            conv.id,
            hubRecipientOf(escritorio),
            conv.keys,
          ),
          200,
        );
        const key2 = await newConversationKey();
        await expectStatus(
          k.rotate(
            olivia,
            active,
            conv.id,
            await k.rotationBody(
              2,
              key2,
              [recipientOf(olivia)],
              [hubRecipientOf(escritorio)],
              serverPk,
            ),
          ),
          200,
        );
        const keys = [...conv.keys, key2];
        const [row] = await db<{ sent_at: Date; requeued_at: Date; now: Date }>(
          `SELECT sent_at, requeued_at, clock_timestamp() AS now FROM conversation_messages WHERE id = $1`,
          [question],
        );
        expect(row!.requeued_at.getTime()).toBeGreaterThan(
          row!.sent_at.getTime() + 2_500,
        );
        // 29 s after the requeue (already > 30 s after sentAt): still the new Hub's.
        clock.offsetMs =
          row!.requeued_at.getTime() + 29_000 - row!.now.getTime();
        await runJob(conv.id);
        expect(await cloudMessages(olivia, { id: conv.id, keys })).toEqual([]);
        expect(
          (await messageRows(conv.id)).find((m) => m.id === question)!.pending,
        ).toBe(true);
        // 31 s after the requeue: the cloud's.
        clock.offsetMs =
          row!.requeued_at.getTime() + 31_000 - row!.now.getTime();
        await runJob(conv.id);
        const answers = await cloudMessages(olivia, { id: conv.id, keys });
        expect(answers.map((m) => m.id)).toEqual([answerIdFor(question)]);
      });

      it('the Hub acks first: the cloud does not answer (no model call, no budget reserved)', async () => {
        const conv = await conversation(olivia, { executor: true });
        const question = await send(olivia, conv, 'liga a luz da sala');
        await expectStatus(k.hubAck(casaToken, conv.id, question), 200);
        const calls = llm.calls.length;
        const reservations = await answerReservations();
        clock.offsetMs = 31_000;
        await runJob(conv.id);
        expect(llm.calls.length).toBe(calls);
        expect(await answerReservations()).toBe(reservations);
        expect(await cloudMessages(olivia, conv)).toEqual([]);
      });
    });

    describe('"responder pela nuvem"', () => {
      it('on a message: the cloud answers at once (the worker, no 30 s wait)', async () => {
        const conv = await conversation(olivia, { executor: true });
        const question = await send(olivia, conv, 'resumo do manual', {
          cloudAnswer: true,
        });
        await eventually(async () => {
          expect((await cloudMessages(olivia, conv)).length).toBe(1);
        });
        const q = (await messagesOf(olivia, conv)).find(
          (m) => m.id === question,
        )!;
        expect(q.cloudAnswerRequested).toBe(true);
        expect(q.ackedByCloud).toBe(true);
      });

      it('on the conversation (any participant; needs the reserve): every new message goes to the cloud at once', async () => {
        const conv = await conversation(olivia, {
          executor: true,
          with: [ana],
        });
        const on = await expectStatus(
          k.setCloudAnswer(ana, active, conv.id, true),
          200,
        );
        expect(on.body.cloudAnswer).toBe(true);
        await send(ana, conv, 'qual o prazo de entrega?');
        await eventually(async () => {
          expect((await cloudMessages(ana, conv)).length).toBe(1);
        });
        // Without the reserve: 422 (the owner switches it off; cloudAnswer goes with it).
        await expectStatus(
          k.setCloudReserve(olivia, active, conv.id, conv.keys, null),
          200,
        );
        const [row] = await db<{ cloud_answer: boolean }>(
          `SELECT cloud_answer FROM conversations WHERE id = $1`,
          [conv.id],
        );
        expect(row!.cloud_answer).toBe(false);
        const again = await k.setCloudAnswer(ana, active, conv.id, true);
        expect(again.status).toBe(422);
        expect(String(again.body.type)).toMatch(/\/cloud-reserve-unavailable$/);
      });
    });

    it('Review Focus 5: a member who is not a participant never gets another conversation’s content', async () => {
      const privateConv = await conversation(olivia, { with: [ana] });
      await send(ana, privateConv, 'o código do cofre azul é 4242');
      await eventually(async () => {
        expect((await cloudMessages(ana, privateConv)).length).toBe(1);
      });
      const brunos = await conversation(bruno);
      await send(bruno, brunos, 'qual o código do cofre azul?');
      await eventually(async () => {
        expect((await cloudMessages(bruno, brunos)).length).toBe(1);
      });
      const call = llm.calls.find((x) =>
        JSON.stringify(x.messages).includes('qual o código do cofre azul?'),
      )!;
      expect(call).toBeDefined();
      expect(JSON.stringify(call)).not.toContain('4242');
      expect(JSON.stringify(call)).not.toContain('cofre azul é');
      const [answer] = await cloudMessages(bruno, brunos);
      expect(answer!.decoded.text).not.toContain('4242');
    });

    describe('documenting (confidentiality alert, ask before writing)', () => {
      let conv: { id: string; keys: ConversationKeys };
      let proposalId: string;

      beforeAll(async () => {
        conv = await conversation(olivia, { executor: true, with: [ana] });
        await expectStatus(k.setCloudAnswer(ana, active, conv.id, true), 200);
      });

      it('content flagged confidential in a broad space: a question with the proposal, nothing written (even if the model tries to record)', async () => {
        llm.enqueue(
          {
            toolCalls: [
              {
                id: 't1',
                name: 'record_document',
                input: { proposalId: newId() },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: 't2',
                name: 'propose_document',
                input: {
                  title: 'Salários 2027',
                  content: '# Salários 2027\n\nAna: R$ 10.000 por mês.',
                  confidential: true,
                },
              },
            ],
          },
          {
            text: 'Isso parece confidencial e o espaço tem 3 pessoas. Gravo mesmo assim, num espaço mais restrito ou não gravo?',
          },
        );
        const first = llm.calls.length;
        await send(ana, conv, 'grava a tabela de salários');
        await eventually(async () => {
          expect((await cloudMessages(ana, conv)).length).toBe(1);
        });
        const [answer] = await cloudMessages(ana, conv);
        const proposal = answer!.decoded.documentProposal as {
          proposalId: string;
          title: string;
          confidential: boolean;
        };
        expect(proposal.title).toBe('Salários 2027');
        expect(proposal.confidential).toBe(true);
        expect(answer!.decoded.text).toContain('confidencial');
        proposalId = proposal.proposalId;
        // The direct record attempt was refused by the server (no proposal shown before), and nothing reached the backup.
        const turns = llm.calls.slice(first);
        expect(turns.length).toBe(3);
        expect(JSON.stringify(turns[1]!.messages)).toContain('no-proposal');
        expect(turns[0]!.system).toContain('Público deste espaço');
        expect(turns[0]!.system).toContain('3 pessoas');
        expect(await backupPlaintext(cloudManifestObjectId(active))).toBeNull();
        expect(
          await backupPlaintext(documentObjectIdFor(proposalId)),
        ).toBeNull();
      });

      it('after the person confirms: the document is in the backup (space key), in the cloud manifest and in the index', async () => {
        llm.enqueue(
          {
            toolCalls: [
              { id: 't3', name: 'record_document', input: { proposalId } },
            ],
          },
          { text: 'Gravei o documento "Salários 2027".' },
        );
        await send(ana, conv, 'sim, pode gravar mesmo assim');
        await eventually(async () => {
          expect((await cloudMessages(ana, conv)).length).toBe(2);
        });
        const answer = (await cloudMessages(ana, conv))[1]!;
        expect(answer.decoded.documentRecorded).toEqual({
          fileId: proposalId,
          title: 'Salários 2027',
        });

        // Backup: the document object (space key) and the cloud manifest listing it.
        const objectId = documentObjectIdFor(proposalId);
        expect(await backupPlaintext(objectId)).toBe(
          '# Salários 2027\n\nAna: R$ 10.000 por mês.',
        );
        const manifestText = (await backupPlaintext(
          cloudManifestObjectId(active),
        ))!;
        expect(manifestText.charCodeAt(0)).toBe(1);
        const manifest = JSON.parse(manifestText.slice(1)) as {
          writer: string;
          files: {
            fileId: string;
            name: string;
            source: { kind: string };
            parts: string[];
          }[];
        };
        expect(manifest.writer).toBe('cloud');
        expect(manifest.files).toEqual([
          expect.objectContaining({
            fileId: proposalId,
            name: 'Salários 2027.md',
            source: { kind: 'cloud' },
            parts: [objectId],
          }),
        ]);
        // Listed like any object (what the Hub sees), recorded on behalf of the person who confirmed.
        const listing = await expectStatus(
          http()
            .get(`/spaces/${active}/backup/objects`)
            .query({ include: 'current' })
            .set(bearer(olivia.token)),
          200,
        );
        const ids = (listing.body.items as { objectId: string }[]).map(
          (i) => i.objectId,
        );
        expect(ids).toEqual(
          expect.arrayContaining([objectId, cloudManifestObjectId(active)]),
        );
        const uploaders = await db<{ uploaded_by_user_id: string }>(
          `SELECT DISTINCT uploaded_by_user_id FROM storage_object_versions
          WHERE object_id = ANY($1::uuid[]) AND status = 'committed'`,
          [[objectId, cloudManifestObjectId(active)]],
        );
        expect(uploaders).toEqual([{ uploaded_by_user_id: ana.userId }]);
        // Indexed right away (a pass with no debounce, then the file job).
        await eventually(async () => {
          const rows = await db<{ text: string }>(
            `SELECT c.text FROM cloud_chunks c JOIN cloud_files f ON f.id = c.cloud_file_id
            WHERE f.file_id = $1 AND f.manifest = 'cloud'`,
            [proposalId],
          );
          expect(rows.map((r) => r.text).join(' ')).toContain('R$ 10.000');
        });
      });
    });

    describe('rechecked under the lock before writing (deactivation / reserve races)', () => {
      it('the answer is written only while the cloud still holds the message: 409 cloud-answer-not-owned, nothing written', async () => {
        const conv = await conversation(olivia, { executor: true });
        const question = await send(olivia, conv, 'pergunta que o Hub pegou');
        await expectStatus(k.hubAck(casaToken, conv.id, question), 200);
        const before = (await messageRows(conv.id)).length;
        await expect(
          app.get(CloudConversationExecutor).send(
            orgId,
            active,
            conv.id,
            {
              id: answerIdFor(question),
              keyVersion: 1,
              encryptedBody: Buffer.alloc(64, 1).toString('base64url'),
              replacesMessageId: null,
            },
            question,
          ),
        ).rejects.toMatchObject({ code: 'cloud-answer-not-owned' });
        expect((await messageRows(conv.id)).length).toBe(before);
      });

      it('a server write to the backup whose guard says no (the space left the cloud meanwhile) writes nothing', async () => {
        const objectId = newId();
        await expect(
          app.get(ServerBackupWriter).write({
            onBehalfOfUserId: olivia.userId,
            spaceId: active,
            guard: async () => false,
            objects: [
              {
                objectId,
                keyVersion: 1,
                blob: new Uint8Array(64).fill(7),
                replacesVersionId: null,
              },
            ],
          }),
        ).rejects.toMatchObject({ code: 'server-write-refused' });
        expect(await backupPlaintext(objectId)).toBeNull();
        const [row] = await db<{ n: number }>(
          `SELECT count(*)::int AS n FROM storage_object_versions WHERE object_id = $1`,
          [objectId],
        );
        expect(row!.n).toBe(0);
      });
    });

    it('budget exhausted: one friendly notice in the conversation (no model call, no cost); the message stays for the Hub', async () => {
      await setAiBudgetInDb(orgId, 0);
      const conv = await conversation(olivia, { executor: true });
      await expectStatus(k.setCloudAnswer(olivia, active, conv.id, true), 200);
      const calls = llm.calls.length;
      const reservations = await answerReservations();
      const first = await send(olivia, conv, 'pergunta 1');
      await eventually(async () => {
        expect((await cloudMessages(olivia, conv)).length).toBe(1);
      });
      const [notice] = await cloudMessages(olivia, conv);
      expect(notice!.decoded).toEqual({
        text: BUDGET_NOTICE_TEXT,
        notice: 'ai-budget-exceeded',
      });
      // A second message of the same backlog: no second notice.
      await send(olivia, conv, 'pergunta 2');
      await eventually(async () => {
        expect(await openJobs(conv.id)).toBe(0);
      });
      expect((await cloudMessages(olivia, conv)).length).toBe(1);
      expect(llm.calls.length).toBe(calls);
      expect(await answerReservations()).toBe(reservations);
      // Not taken by the cloud: still pending, and the Hub goes on normally.
      expect(
        (await messageRows(conv.id)).find((m) => m.id === first)!.pending,
      ).toBe(true);
      await expectStatus(k.hubAck(casaToken, conv.id, first), 200);
    });
  },
);
