import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { HubAuth } from '../../../shared/infra/http/hub-auth.decorators.js';
import { ServerKeyring } from '../../application/ports/server-keyring.js';

// A pública X25519 do servidor, para o app selar a cópia da chave do espaço/assunto (nuvem ativa). Qualquer usuário
// autenticado (é pública; o guard global exige o token). Só a pública: a privada nunca sai do ServerKeyring.
@ApiTags('cloud')
@Controller('cloud')
export class CloudServerKeyController {
  constructor(private readonly keyring: ServerKeyring) {}

  @ApiBearerAuth()
  @Get('server-key')
  async serverKey(): Promise<{ publicKey: string }> {
    return { publicKey: await this.keyring.publicKey() };
  }
}

// A mesma pública para o Hub executor (token de Hub): a troca da chave de um assunto com a nuvem de reserva também tranca
// a versão nova para o servidor (spec active-cloud §4.3), e o Hub pode fazer essa troca.
@ApiTags('cloud')
@Controller('hub/cloud')
export class HubCloudServerKeyController {
  constructor(private readonly keyring: ServerKeyring) {}

  @HubAuth()
  @ApiBearerAuth()
  @Get('server-key')
  async serverKey(): Promise<{ publicKey: string }> {
    return { publicKey: await this.keyring.publicKey() };
  }
}
