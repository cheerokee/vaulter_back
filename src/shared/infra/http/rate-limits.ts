// Limites do rate limit (ttl em milissegundos, como no @nestjs/throttler v6).
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const RATE_LIMITS = {
  /** Qualquer rota sem limite próprio: por IP. */
  default: { limit: 300, ttl: MINUTE },
  prelogin: { limit: 30, ttl: MINUTE },
  register: { limit: 10, ttl: HOUR },
  /** Login: dois contadores, por IP (`default`) e por e-mail normalizado (`email`). */
  loginIp: { limit: 10, ttl: MINUTE },
  loginEmail: { limit: 5, ttl: MINUTE },
  refresh: { limit: 60, ttl: MINUTE },
  /**
   * Reautenticação (prova da senha atual): por usuário autenticado, UM orçamento para todas as rotas marcadas
   * com @ThrottleReauth() (`PUT /me/password`, `PUT /organizations/:id/recovery-key`,
   * `POST /spaces/:id/recover`).
   */
  reauth: { limit: 5, ttl: 15 * MINUTE },
  /** Prévia pública e aceite de convite: por IP. */
  invitationPreview: { limit: 30, ttl: MINUTE },
  invitationAccept: { limit: 10, ttl: MINUTE },
} as const;

/** Nome do throttler extra, cobrado só nas rotas marcadas com @ThrottleByEmail(). */
export const EMAIL_THROTTLER = 'email';

/** Nome do throttler de reautenticação, cobrado só nas rotas marcadas com @ThrottleReauth(). */
export const REAUTH_THROTTLER = 'reauth';
