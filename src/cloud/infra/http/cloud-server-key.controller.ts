import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
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
