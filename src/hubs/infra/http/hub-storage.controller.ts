import { Body, Controller, HttpCode, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ReportHubStorageUseCase } from '../../application/report-hub-storage.use-case.js';
import {
  CurrentHub,
  HubAuth,
  type HubAuthContext,
} from '../../../shared/infra/http/hub-auth.decorators.js';
import { HubStorageDto } from './dto/hub.dto.js';

// Rota interna do Hub (sem a tag `public`): só token de Hub.
@ApiTags('hubs')
@Controller('hub')
export class HubStorageController {
  constructor(private readonly report: ReportHubStorageUseCase) {}

  /** The hub reports its usable SSD capacity (on authentication and whenever it changes). */
  @ApiBearerAuth()
  @HubAuth()
  @HttpCode(204)
  @Put('storage')
  async doReport(
    @CurrentHub() hub: HubAuthContext,
    @Body() dto: HubStorageDto,
  ): Promise<void> {
    await this.report.execute(hub, { capacityBytes: dto.capacityBytes });
  }
}
