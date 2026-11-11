import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import sodium from 'libsodium-wrappers-sumo';
import { IndexFileJob } from '../../src/cloud/application/indexing/index-file.job.js';
import {
  Embedder,
  type EmbeddingKind,
} from '../../src/cloud/application/ports/embedder.js';
import {
  docxBytes,
  pdfBytes,
  xlsxBytes,
} from '../../src/cloud/testing/document-fixtures.js';
import { FakeEmbedder } from '../../src/cloud/testing/fake-embedder.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import {
  expectStatus,
  identityClient,
  type KeyedUser,
} from '../support/identity-client.js';
import {
  cloudManifestObjectId,
  cloudSwitch,
  simulatedHub,
} from '../support/space-manifest.js';

const DOCX =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const enc = (s: string) => new TextEncoder().encode(s);

/** The fake embedder, with a gate a test can close to hold a job inside `embed` (key already opened). */
class GatedEmbedder extends FakeEmbedder {
  private gate: Promise<void> | null = null;
  private open: (() => void) | null = null;
  private onEnter: (() => void) | null = null;

  /** Closes the gate; resolves when a job is waiting at it. */
  hold(): Promise<void> {
    this.gate = new Promise((resolve) => {
      this.open = resolve;
    });
    return new Promise((resolve) => {
      this.onEnter = resolve;
    });
  }

  release(): void {
    this.open?.();
    this.gate = null;
  }

  async embed(texts: readonly string[], kind: EmbeddingKind) {
    if (this.gate) {
      this.onEnter?.();
      await this.gate;
    }
    return super.embed(texts, kind);
  }
}

// Indexação da nuvem ativa a partir do backup cifrado (spec active-cloud §4.2), ponta a ponta: o Hub simulado sobe
// arquivos e o manifesto no formato do contrato (docs/hubs/space-manifest.md) pelas rotas reais do backup (LocalStack),
// o espaço liga pelas rotas reais (KMS do LocalStack) e os workers do pg-boss rodam de verdade; o embedder é o falso
// determinístico (DI). Review Focus 1: desligar com um job que já abriu a chave não deixa linha.
describe('active cloud indexing from the encrypted backup (e2e, workers on)', () => {
  let app: INestApplication;
  const embedder = new GatedEmbedder();
  const c = identityClient(() => app);
  const hub = simulatedHub(() => app);
  const cloud = cloudSwitch(() => app);

  let ana: KeyedUser;
  let orgId: string;
  let kitPk: string;

  const db = async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
    (await adminDataSource()).query(sql, params);

  const fileRows = (spaceId: string) =>
    db<{
      id: string;
      file_id: string;
      name: string;
      status: string;
      skip_reason: string | null;
      chunk_count: number;
      embedding_model: string | null;
      indexed_at: Date | null;
    }>(
      `SELECT id, file_id, name, status, skip_reason, chunk_count, embedding_model, indexed_at
         FROM cloud_files WHERE space_id = $1 ORDER BY name`,
      [spaceId],
    );
  const chunkRows = (spaceId: string) =>
    db<{ id: string; file_id: string; text: string; embedding_model: string }>(
      `SELECT id, file_id, text, embedding_model FROM cloud_chunks WHERE space_id = $1 ORDER BY file_id, position`,
      [spaceId],
    );
  const countRows = async (table: string, spaceId: string) =>
    (
      await db<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table} WHERE space_id = $1`,
        [spaceId],
      )
    )[0]!.n;

  /** Polls until `check` passes (the workers poll every 2 s and the space pass waits 2 s of debounce). */
  const eventually = async (check: () => Promise<void>, timeoutMs = 30_000) => {
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

  const newSpace = async (name: string) => {
    const created = await c.spaces.create(ana, orgId, kitPk, name);
    expect(created.res.status).toBe(201);
    return { spaceId: created.spaceId, key: created.key };
  };

  beforeAll(async () => {
    await sodium.ready;
    await resetDatabase();
    app = await createTestApp({
      env: { JOB_WORKERS_ENABLED: 'true' },
      overrides: [{ provide: Embedder, useValue: embedder }],
    });
    ana = await c.spaces.signUpKeyed('ana@example.com', 'Ana');
    const org = await c.spaces.orgWithKit(ana);
    orgId = org.orgId;
    kitPk = org.kit.publicKey;
  }, 60_000);

  afterAll(async () => {
    embedder.release();
    await app?.close();
  });

  describe('a space with a Hub backup', () => {
    let space: { spaceId: string; key: Uint8Array };
    let sim: ReturnType<ReturnType<typeof simulatedHub>['forSpace']>;
    const files: Record<string, string> = {};
    const warn = vi.spyOn(Logger.prototype, 'warn');

    beforeAll(async () => {
      space = await newSpace('Manuais');
      sim = hub.forSpace(ana, space);
      files.md = (
        await sim.addFile(
          'Processo de compras.md',
          'text/markdown',
          enc(
            '# Compras\n\nPara aprovar uma compra de última hora no Orion, o gestor abre a requisição e confirma o centro de custo.\n\nDepois o financeiro libera o pagamento.',
          ),
        )
      ).fileId;
      files.docx = (
        await sim.addFile(
          'Contrato.docx',
          DOCX,
          docxBytes([
            'Cláusula primeira: o fornecimento de brita será mensal e contínuo durante todo o contrato.',
            'Cláusula segunda: o pagamento vence no dia dez de cada mês, com multa de dois por cento.',
          ]),
          { parts: 2 },
        )
      ).fileId;
      files.xlsx = (
        await sim.addFile(
          'Tabela de preços.xlsx',
          XLSX,
          xlsxBytes([
            {
              name: 'Preços',
              rows: [
                ['Produto', 'Preço por tonelada em reais'],
                ['Brita número um', '120'],
                ['Areia lavada fina', '90'],
              ],
            },
          ]),
          { source: { kind: 'connector', connector: 'google-drive' } },
        )
      ).fileId;
      files.pdf = (
        await sim.addFile(
          'Relatorio.pdf',
          'application/pdf',
          pdfBytes([
            'Relatorio mensal da pedreira: producao de oitenta mil toneladas',
            'Manutencao do britador primario prevista para dezembro',
          ]),
        )
      ).fileId;
      files.png = (
        await sim.addFile(
          'Foto secreta da obra.png',
          'image/png',
          enc('PNG...'),
        )
      ).fileId;
      // In encrypted_backup nothing is read nor enqueued.
      expect(
        await db(
          `SELECT 1 FROM pgboss.job WHERE name LIKE 'cloud.%' AND data->>'spaceId' = $1`,
          [space.spaceId],
        ),
      ).toEqual([]);
    }, 120_000);

    it('switching on indexes every file of the manifest; an unknown format is skipped with a log line without the name', async () => {
      warn.mockClear();
      await cloud.switchOn(ana, orgId, space.spaceId, [space.key]);
      await eventually(async () => {
        const rows = await fileRows(space.spaceId);
        expect(rows).toHaveLength(5);
        expect(rows.every((r) => r.status !== 'pending')).toBe(true);
      });
      const rows = await fileRows(space.spaceId);
      expect(
        rows.map((r) => [r.name, r.status, r.skip_reason, r.embedding_model]),
      ).toEqual([
        ['Contrato.docx', 'indexed', null, 'fake-embedding'],
        ['Foto secreta da obra.png', 'skipped', 'unsupported-format', null],
        ['Processo de compras.md', 'indexed', null, 'fake-embedding'],
        ['Relatorio.pdf', 'indexed', null, 'fake-embedding'],
        ['Tabela de preços.xlsx', 'indexed', null, 'fake-embedding'],
      ]);
      const chunks = await chunkRows(space.spaceId);
      const textOf = (fileId: string) =>
        chunks
          .filter((ch) => ch.file_id === fileId)
          .map((ch) => ch.text)
          .join('\n');
      expect(textOf(files.md!)).toContain('centro de custo');
      // Two parts joined in order before reading the zip.
      expect(textOf(files.docx!)).toContain('Cláusula segunda');
      expect(textOf(files.xlsx!)).toContain('Brita número um 120');
      expect(textOf(files.pdf!)).toContain('britador primario');
      expect(textOf(files.png!)).toBe('');
      expect(
        chunks.every((ch) => ch.embedding_model === 'fake-embedding'),
      ).toBe(true);
      // The embedding is a real vector(768) the cosine search uses.
      const [nearest] = await db<{ file_id: string }>(
        `SELECT file_id FROM cloud_chunks WHERE space_id = $1
          ORDER BY embedding <=> (SELECT embedding FROM cloud_chunks WHERE file_id = $2 LIMIT 1) LIMIT 1`,
        [space.spaceId, files.pdf],
      );
      expect(nearest!.file_id).toBe(files.pdf);
      // "Ignored with a log line": ids, the type and the reason; never the name.
      const skipped = warn.mock.calls.find(
        (call) => call[1] === 'cloud file not indexed',
      );
      expect(skipped?.[0]).toMatchObject({
        spaceId: space.spaceId,
        mediaType: 'image/png',
        reason: 'unsupported-format',
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('Foto secreta');
    }, 60_000);

    it('a new upload reindexes only that file', async () => {
      const before = await chunkRows(space.spaceId);
      const otherIds = before
        .filter((ch) => ch.file_id !== files.md)
        .map((ch) => ch.id);
      const mdRow = (await fileRows(space.spaceId)).find(
        (r) => r.file_id === files.md,
      )!;
      const callsBefore = embedder.calls.length;
      await sim.replaceContent(
        files.md!,
        enc(
          'Novo procedimento de compras: toda compra urgente precisa da aprovação do diretor de operações antes do pedido.',
        ),
      );
      await eventually(async () => {
        const row = (await fileRows(space.spaceId)).find(
          (r) => r.file_id === files.md,
        )!;
        expect(row.status).toBe('indexed');
        expect(row.indexed_at!.getTime()).toBeGreaterThan(
          mdRow.indexed_at!.getTime(),
        );
      });
      const after = await chunkRows(space.spaceId);
      // The other files kept their chunks (same rows); only the changed one was embedded again.
      expect(
        after.filter((ch) => ch.file_id !== files.md).map((ch) => ch.id),
      ).toEqual(otherIds);
      const md = after.filter((ch) => ch.file_id === files.md);
      expect(md.map((ch) => ch.text).join()).toContain('diretor de operações');
      expect(md.map((ch) => ch.text).join()).not.toContain('centro de custo');
      expect(embedder.calls.slice(callsBefore)).toEqual([
        { count: md.length, kind: 'document' },
      ]);
    }, 60_000);

    it('deleting a file removes its chunks', async () => {
      await sim.removeFile(files.docx!);
      await eventually(async () => {
        const rows = await fileRows(space.spaceId);
        expect(rows.map((r) => r.file_id)).not.toContain(files.docx);
      });
      const chunks = await chunkRows(space.spaceId);
      expect(chunks.some((ch) => ch.file_id === files.docx)).toBe(false);
      expect(chunks.length).toBeGreaterThan(0);
    }, 60_000);

    it('switching off while a job holds the opened key leaves no legible row (Review Focus 1)', async () => {
      const waiting = embedder.hold();
      const added = await sim.addFile(
        'Ata da reunião.md',
        'text/markdown',
        enc(
          'Ata: decidimos trocar o fornecedor de explosivos a partir de janeiro e revisar o plano de fogo.',
        ),
      );
      // The file job read the parts, opened the key and is now inside `embed`.
      await waiting;
      await cloud.switchOff(ana, space.spaceId);
      expect(await countRows('cloud_chunks', space.spaceId)).toBe(0);
      expect(await countRows('cloud_files', space.spaceId)).toBe(0);
      expect(await countRows('cloud_space_key_grants', space.spaceId)).toBe(0);
      embedder.release();
      // The job finishes (it sees the space switched off under the lock and writes nothing).
      await eventually(async () => {
        const jobs = await db<{ state: string }>(
          `SELECT state FROM pgboss.job WHERE name = 'cloud.index-file' AND data->>'spaceId' = $1
             AND state IN ('created', 'retry', 'active')`,
          [space.spaceId],
        );
        expect(jobs).toEqual([]);
      });
      expect(await countRows('cloud_chunks', space.spaceId)).toBe(0);
      expect(await countRows('cloud_files', space.spaceId)).toBe(0);
      void added;
    }, 60_000);
  });

  it('the same race, deterministic: the job resumes after the switch-off committed and writes nothing', async () => {
    // Without relying on the worker: the job is called directly, held in `embed`, while the space is switched off.
    const space = await newSpace('Atas');
    const sim = hub.forSpace(ana, space);
    await sim.addFile(
      'Ata.md',
      'text/markdown',
      enc(
        'Uma ata com texto suficiente para virar um trecho indexado pela nuvem ativa.',
      ),
    );
    const waitingPass = embedder.hold();
    await cloud.switchOn(ana, orgId, space.spaceId, [space.key]);
    // The worker took the first file job: let it finish, then hold the next one we call directly.
    await waitingPass;
    embedder.release();
    await eventually(async () => {
      const rows = await fileRows(space.spaceId);
      expect(rows.map((r) => r.status)).toEqual(['indexed']);
    });
    const [row] = await fileRows(space.spaceId);
    // Force it back to pending, as a new version would, and run the job by hand.
    await db(`UPDATE cloud_files SET status = 'pending' WHERE id = $1`, [
      row!.id,
    ]);
    const waiting = embedder.hold();
    const run = app.get(IndexFileJob).run({
      organizationId: orgId,
      spaceId: space.spaceId,
      cloudFileId: row!.id,
    });
    await waiting;
    await cloud.switchOff(ana, space.spaceId);
    embedder.release();
    await run;
    expect(await countRows('cloud_chunks', space.spaceId)).toBe(0);
    expect(await countRows('cloud_files', space.spaceId)).toBe(0);
  }, 60_000);

  it('the cloud manifest id is reserved to the server: a person (or Hub) cannot upload or delete it', async () => {
    const space = await newSpace('Reservado');
    const res = await c
      .http()
      .post(`/spaces/${space.spaceId}/backup/uploads`)
      .set(c.bearer(ana.token))
      .send({
        items: [
          {
            objectId: cloudManifestObjectId(space.spaceId),
            keyVersion: 1,
            sizeBytes: 100,
            sha256: 'a'.repeat(64),
            replacesVersionId: null,
          },
        ],
      });
    expect(res.status).toBe(422);
    expect(res.body.type).toMatch(/object-id-reserved$/);
    await expectStatus(
      c.http().get(`/spaces/${space.spaceId}`).set(c.bearer(ana.token)),
      200,
    );
  });
});
