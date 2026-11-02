import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { SyncItem } from '../../application/ports/hub-sync-reader.js';
import { SyncHubUseCase } from '../../application/sync-hub.use-case.js';
import {
  CurrentHub,
  HubAuth,
  type HubAuthContext,
} from './hub-auth.decorators.js';
import { HubSyncQuery } from './dto/sync.dto.js';

// `sync_version` comes from a bigint sequence; as a JSON number it is exact up to 2^53 (far beyond any real count).
function toJsonNumber(value: bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error('sync_version exceeds the JSON safe integer range');
  }
  return n;
}

const syncItemResponse = (i: SyncItem) => ({
  type: i.type,
  syncVersion: toJsonNumber(i.syncVersion),
  deleted: i.deleted,
  data: i.data,
});

// Rota interna do Hub (sem a tag `public`): só token de Hub.
@ApiTags('hub')
@Controller('hub')
export class HubSyncController {
  constructor(private readonly sync: SyncHubUseCase) {}

  @ApiBearerAuth()
  @HubAuth()
  @Get('sync')
  async doSync(
    @CurrentHub() hub: HubAuthContext,
    @Query() query: HubSyncQuery,
  ) {
    const page = await this.sync.execute(hub, {
      since: BigInt(query.since),
      limit: query.limit,
    });
    return {
      items: page.items.map(syncItemResponse),
      nextSince: toJsonNumber(page.nextSince),
    };
  }
}
