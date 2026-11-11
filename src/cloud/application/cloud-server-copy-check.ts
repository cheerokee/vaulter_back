import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ServerKeyCopyCheck } from '../../shared/application/server-key-copy-check.js';
import { ServerKeyring } from './ports/server-keyring.js';
import { assertOpensWithServerKey } from './server-copy.js';

const NAME = 'cloud.server-key';

// Registra o verificador das cópias seladas para a chave do servidor (`ServerKeyCopyCheck`) para módulos que as guardam
// sem conhecer o `cloud` (o `conversations`: cópias da chave do assunto para a nuvem de reserva). Mesma prova do
// ligar/da troca de chave do espaço: a cópia abre com a chave do servidor (422 `server-copy-invalid`), e a chave aberta
// é apagada da memória na hora.
@Injectable()
export class CloudServerCopyCheck implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly check: ServerKeyCopyCheck,
    private readonly keyring: ServerKeyring,
  ) {}

  onModuleInit(): void {
    this.check.register({
      name: NAME,
      assertOpens: (copy) => assertOpensWithServerKey(this.keyring, copy),
      prepare: () => this.keyring.prepare(),
    });
  }

  onModuleDestroy(): void {
    this.check.unregister(NAME);
  }
}
