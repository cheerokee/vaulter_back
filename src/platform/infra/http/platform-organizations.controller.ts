import { Body, Controller, HttpCode, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type AuthContext,
  CurrentAuth,
} from '../../../shared/infra/http/auth.decorators.js';
import { ThrottleReauth } from '../../../shared/infra/http/throttling.decorators.js';
import { uuidPipe } from '../../../shared/infra/http/uuid-pipe.js';
import { SetOrganizationStorageQuotaUseCase } from '../../application/set-organization-storage-quota.use-case.js';
import { SetStorageQuotaDto } from './dto/storage-quota.dto.js';
import {
  PlatformRoutes,
  RequirePlatformPermission,
} from './platform-permission.decorator.js';

// Ajustes de organização feitos pela equipe (financeiro). Sem a permissão: 404 (PlatformPermissionGuard).
@ApiTags('platform')
@PlatformRoutes()
@Controller('platform/organizations')
export class PlatformOrganizationsController {
  constructor(private readonly setQuota: SetOrganizationStorageQuotaUseCase) {}

  /** Sets the cloud storage quota; 422 `storage-quota-below-reserved` below what the spaces already reserve. */
  @ApiBearerAuth()
  @RequirePlatformPermission('platform.billing.storage_quota')
  @ThrottleReauth()
  @Put(':orgId/storage-quota')
  @HttpCode(200)
  doSetQuota(
    @CurrentAuth() auth: AuthContext,
    @Param('orgId', uuidPipe('orgId')) orgId: string,
    @Body() dto: SetStorageQuotaDto,
  ) {
    return this.setQuota.execute(auth, orgId, {
      quotaBytes: dto.quotaBytes,
      reason: dto.reason,
      currentAuthProof: dto.currentAuthProof,
    });
  }
}
