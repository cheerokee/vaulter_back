import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type AuthContext,
  CurrentAuth,
} from '../../../shared/infra/http/auth.decorators.js';
import { uuidPipe } from '../../../shared/infra/http/uuid-pipe.js';
import { AddHubSpaceUseCase } from '../../application/add-hub-space.use-case.js';
import { GrantRoomUseCase } from '../../application/grant-room.use-case.js';
import { ListHubSpacesUseCase } from '../../application/list-hub-spaces.use-case.js';
import { RemoveHubSpaceUseCase } from '../../application/remove-hub-space.use-case.js';
import { RevokeRoomUseCase } from '../../application/revoke-room.use-case.js';
import { AddHubSpaceDto, GrantRoomDto } from './dto/hub.dto.js';
import { hubSpaceResponse } from './dto/responses.js';

// Espaços no Hub e a Sala. Só cópias trancadas passam por aqui: o backend nunca vê a chave do espaço em claro.
// Rotas internas do app (sem a tag `public`), só token de usuário.
@ApiTags('hubs')
@Controller('hubs/:id/spaces')
export class HubSpacesController {
  constructor(
    private readonly list: ListHubSpacesUseCase,
    private readonly add: AddHubSpaceUseCase,
    private readonly remove: RemoveHubSpaceUseCase,
    private readonly grantRoom: GrantRoomUseCase,
    private readonly revokeRoom: RevokeRoomUseCase,
  ) {}

  /** Owner: every space of the hub; others: those of their organizations. */
  @ApiBearerAuth()
  @Get()
  async doList(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
  ) {
    return {
      items: (await this.list.execute(auth, id)).map(hubSpaceResponse),
    };
  }

  /** Owner (member of the space) or a Gestor of the space in a linked organization. */
  @ApiBearerAuth()
  @Post()
  async doAdd(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Body() dto: AddHubSpaceDto,
  ) {
    return hubSpaceResponse(
      await this.add.execute(auth, { hubId: id, spaceId: dto.spaceId }),
    );
  }

  /** Owner: any space; Gestor: their own. Also takes the space out of the Room. */
  @ApiBearerAuth()
  @Delete(':spaceId')
  @HttpCode(204)
  async doRemove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Param('spaceId', uuidPipe('spaceId')) spaceId: string,
  ): Promise<void> {
    await this.remove.execute(auth, { hubId: id, spaceId });
  }

  /** The owner, Gestor of the space, opens it in the Room: every key version sealed for the hub. */
  @ApiBearerAuth()
  @Put(':spaceId/room')
  async doGrantRoom(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Param('spaceId', uuidPipe('spaceId')) spaceId: string,
    @Body() dto: GrantRoomDto,
  ) {
    return this.grantRoom.execute(auth, {
      hubId: id,
      spaceId,
      ...(dto.roleKey !== undefined ? { roleKey: dto.roleKey } : {}),
      recoveryPublicKey: dto.recoveryPublicKey,
      grants: dto.grants.map((g) => ({
        version: g.version,
        wrappedKey: g.wrappedKey,
      })),
    });
  }

  /** Owner or Gestor takes the space out of the Room: tombstones the copies and the role, rotation pending. */
  @ApiBearerAuth()
  @Delete(':spaceId/room')
  @HttpCode(204)
  async doRevokeRoom(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidPipe('id')) id: string,
    @Param('spaceId', uuidPipe('spaceId')) spaceId: string,
  ): Promise<void> {
    await this.revokeRoom.execute(auth, { hubId: id, spaceId });
  }
}
