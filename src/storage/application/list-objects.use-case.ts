import { Injectable } from '@nestjs/common';
import { DomainValidationError } from '../../shared/domain/errors.js';
import {
  type CursorPage,
  decodeCursor,
  pageFrom,
} from '../../shared/domain/pagination.js';
import {
  BackupIndexReader,
  type ListedObject,
  type StoredObjectVersion,
} from './ports/backup-index-reader.js';
import { StorageAccess, type StorageActor } from './storage-access.js';

export type ListObjectsQuery = {
  /** `current` (default): live objects, or what changed since `since`; `trash`; `versions` of `objectId`. */
  include: 'current' | 'trash' | 'versions';
  since?: Date;
  objectId?: string;
  cursor?: string;
  limit: number;
};

export type ListObjectsResult =
  | {
      include: 'current' | 'trash';
      page: CursorPage<ListedObject>;
      asOf: Date;
    }
  | {
      include: 'versions';
      page: CursorPage<StoredObjectVersion>;
      asOf: Date;
    };

function invalid(detail: string): DomainValidationError {
  return new DomainValidationError('validation-failed', detail);
}

// Listar o índice do backup de um espaço (spec storage-backup §4.3), por cursor (id do objeto; versões: id da versão,
// que é UUID v7, então em ordem de envio). Quem: Hub com o espaço na Sala (qualquer papel) ou membro com `memory.read`
// (todo papel de espaço); o resto 404 sem revelar o espaço (`StorageAccess.require`, sem trava). Só o índice: nada é
// lido do S3. `since` (só em `current`/`trash`) filtra pelo `updated_at` da linha do objeto; `asOf` é o relógio do
// banco na consulta, para o próximo `since` (com folga: a hora gravada é a do início da transação que mudou o objeto).
@Injectable()
export class ListObjectsUseCase {
  constructor(
    private readonly access: StorageAccess,
    private readonly reader: BackupIndexReader,
  ) {}

  async execute(
    actor: StorageActor,
    spaceId: string,
    query: ListObjectsQuery,
  ): Promise<ListObjectsResult> {
    if (query.include === 'versions') {
      if (!query.objectId) {
        throw invalid('objectId is required with include=versions.');
      }
      if (query.since) {
        throw invalid('since cannot be used with include=versions.');
      }
    } else if (query.objectId) {
      throw invalid('objectId is only accepted with include=versions.');
    }
    const after = query.cursor ? decodeCursor(query.cursor) : undefined;
    const slice = { after, limit: query.limit };
    const space = await this.access.require(spaceId, actor, 'memory.read');
    if (query.include === 'versions') {
      const { rows, asOf } = await this.reader.listVersions(
        space.organizationId,
        space.spaceId,
        query.objectId!,
        slice,
      );
      return {
        include: 'versions',
        page: pageFrom(rows, query.limit, (v) => v.versionId),
        asOf,
      };
    }
    const { rows, asOf } = await this.reader.listObjects(
      space.organizationId,
      space.spaceId,
      query.since
        ? { include: query.include, since: query.since }
        : { include: query.include },
      slice,
    );
    return {
      include: query.include,
      page: pageFrom(rows, query.limit, (o) => o.objectId),
      asOf,
    };
  }
}
