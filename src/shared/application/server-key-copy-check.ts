import { Injectable } from '@nestjs/common';

export type ServerKeyCopyVerifier = {
  name: string;
  /**
   * Throws (422 `server-copy-invalid`) unless the copy (`0x01 ‖ crypto_box_seal`, 108 base64url chars) opens with the
   * server key. The opened key never leaves the verifier.
   */
  assertOpens(copy: string): Promise<void>;
  /** Loads the server keys into memory; called BEFORE the unit of work in which `assertOpens` will run. */
  prepare(): Promise<void>;
};

// Prova de que uma cópia de chave foi selada para a chave do SERVIDOR (o formato sozinho não diz para qual chave), para
// módulos que guardam essas cópias sem conhecer o `cloud` (o `conversations`, nas cópias da chave do assunto para a
// nuvem de reserva). O `cloud` registra o verificador (ServerKeyring) em `onModuleInit`; só um. Sem verificador, uma
// cópia para o servidor é erro de programação (nunca do cliente): o espaço só fica em `active_cloud` pelo `cloud`.
@Injectable()
export class ServerKeyCopyCheck {
  private verifier: ServerKeyCopyVerifier | null = null;

  register(verifier: ServerKeyCopyVerifier): void {
    if (this.verifier) {
      throw new Error(
        `A server key copy verifier ("${this.verifier.name}") is already registered.`,
      );
    }
    this.verifier = verifier;
  }

  unregister(name: string): void {
    if (this.verifier?.name === name) this.verifier = null;
  }

  /**
   * Called before `UnitOfWork.run` by a use case that will check server copies inside it: the verifier loads the
   * server keys now (KMS outside any transaction), so `assertOpens` under the locks works from memory. No verifier:
   * nothing to do (the copy is refused later by `assertOpens`).
   */
  async prepare(): Promise<void> {
    await this.verifier?.prepare();
  }

  async assertOpens(copy: string): Promise<void> {
    if (!this.verifier) {
      throw new Error(
        'A server key copy was sent but no server key copy verifier is registered.',
      );
    }
    await this.verifier.assertOpens(copy);
  }
}
