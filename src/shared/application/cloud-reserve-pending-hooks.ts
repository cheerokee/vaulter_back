import { Injectable } from '@nestjs/common';

export type CloudReservePendingContext = {
  organizationId: string;
  spaceId: string;
  conversationId: string;
  /** A live `pending` message of a conversation with the cloud reserve on. */
  messageId: string;
  /**
   * Why it is (again) waiting: `sent` (a person sent it), `requeued` (the Hub that acknowledged it stopped being the
   * executor without answering), `reserve_enabled` (the reserve was switched on while it waited) or `key_rotated` (a
   * pending key rotation, which keeps the cloud from writing, was just done) or `cloud_answer` ("responder pela nuvem"
   * was switched on for the conversation).
   */
  reason:
    'sent' | 'requeued' | 'reserve_enabled' | 'key_rotated' | 'cloud_answer';
  /**
   * The Hub gets no head start: "responder pela nuvem" (on the message or the conversation) or no executor Hub at all.
   * Otherwise the cloud waits `CLOUD_FALLBACK_AFTER_MS` from the message's `sentAt` for a Hub ack.
   */
  immediate: boolean;
};

export type CloudReservePendingHook = {
  name: string;
  onPending(ctx: CloudReservePendingContext): Promise<void>;
};

// Registro global do sinal "há uma mensagem `pending` num assunto com a nuvem de reserva" (spec active-cloud §4.3): o
// `conversations` emite, sem conhecer quem assina (o `cloud`, que agenda a resposta de reserva). Roda em sequência
// DENTRO do unit of work que deixou a mensagem pendente (envio, volta à fila, ligar a reserva, troca de chave que
// destrava a escrita), com o assunto travado:
// quem assina só agenda (ex.: tarefa do pg-boss na mesma transação, que some se ela desfizer), nunca chama nada
// externo nem trava outra linha de assunto. Erro de um desfaz a operação. Sem assinante, nada acontece (o Hub continua
// sendo o executor; a mensagem espera).
@Injectable()
export class CloudReservePendingHooks {
  private readonly hooks: CloudReservePendingHook[] = [];

  register(hook: CloudReservePendingHook): void {
    if (this.hooks.some((h) => h.name === hook.name)) {
      throw new Error(
        `Cloud-reserve-pending hook "${hook.name}" is already registered.`,
      );
    }
    this.hooks.push(hook);
  }

  unregister(name: string): void {
    const i = this.hooks.findIndex((h) => h.name === name);
    if (i >= 0) this.hooks.splice(i, 1);
  }

  async run(ctx: CloudReservePendingContext): Promise<void> {
    for (const hook of this.hooks) await hook.onPending(ctx);
  }
}
