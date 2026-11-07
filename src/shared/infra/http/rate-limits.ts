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
   * Recuperação da conta (`POST /auth/recovery/lookup` e `POST /auth/recovery/complete`, públicas): por IP, UM
   * orçamento para as duas rotas (grupo `THROTTLE_GROUPS.accountRecovery`), mais o contador por e-mail do login
   * (`loginEmail`, por rota). A prova tem 256 bits: o limite é contra abuso, não contra adivinhação.
   */
  accountRecoveryIp: { limit: 10, ttl: MINUTE },
  /**
   * Reautenticação (prova da senha atual): por usuário autenticado, UM orçamento para todas as rotas marcadas
   * com @ThrottleReauth() (`PUT /me/password`, `PUT /organizations/:id/recovery-key`,
   * `POST /spaces/:id/recover`, `POST /spaces/:id/recover/copies`).
   */
  reauth: { limit: 5, ttl: 15 * MINUTE },
  /**
   * Troca da chave de um espaço (`POST /spaces/:id/keys`): por usuário, contador próprio. Cada troca é uma versão
   * nova, e pôr membro/retrancar/reabrir mandam todas as versões num pedido só.
   */
  spaceKeyRotation: { limit: 10, ttl: HOUR },
  /** Prévia pública e aceite de convite: por IP. */
  invitationPreview: { limit: 30, ttl: MINUTE },
  invitationAccept: { limit: 10, ttl: MINUTE },
  /** Apresentação do Hub (`POST /hub-enrollments`, pública): por IP. */
  hubEnroll: { limit: 20, ttl: HOUR },
  /** Consulta do status da apresentação (`GET /hub-enrollments/:id/status`, pública): por IP. */
  hubStatus: { limit: 120, ttl: HOUR },
  /**
   * Autenticação do Hub (`POST /hub-auth/challenge` e `POST /hub-auth/token`, públicas): por IP, UM orçamento para
   * as duas rotas (grupo `THROTTLE_GROUPS.hubAuth`, veja `ThrottleGroup`). Um Hub faz um par a cada 15 min (8 de 60 por hora).
   */
  hubAuth: { limit: 60, ttl: HOUR },
  /**
   * Reivindicação de Hub (`POST /hubs/claim`): dois contadores, como o login. Por IP (`default`, `hubClaimIp`), contra
   * quem cria várias contas para somar tentativas, e por usuário (throttler `user`, `hubClaimUser`, via
   * `@ThrottleByUser`), forte: o código de 8 dígitos não pode ser adivinhado.
   */
  hubClaimIp: { limit: 30, ttl: HOUR },
  hubClaimUser: { limit: 10, ttl: HOUR },
  /** Pedido de vínculo por código (`POST /hubs/link-requests`): por usuário. */
  hubLinkRequest: { limit: 10, ttl: HOUR },
  /** Código de vínculo pedido pelo Hub (`POST /hub/link-codes`): por Hub. */
  hubLinkCode: { limit: 30, ttl: HOUR },
  /** Sincronização do Hub (`GET /hub/sync`): por Hub. */
  hubSync: { limit: 120, ttl: HOUR },
} as const;

/** Nome do throttler extra, cobrado só nas rotas marcadas com @ThrottleByEmail(). */
export const EMAIL_THROTTLER = 'email';

/**
 * Nome do throttler por usuário, cobrado só nas rotas marcadas com @ThrottleByUser() (contador próprio por rota,
 * chaveado pelo usuário autenticado). Para rotas que já usam o `default` para outro contador (ex.: por IP).
 */
export const USER_THROTTLER = 'user';

/** Nome do throttler de reautenticação, cobrado só nas rotas marcadas com @ThrottleReauth(). */
export const REAUTH_THROTTLER = 'reauth';

/**
 * Contadores divididos entre rotas (`@ThrottleGroup`): UMA constante por grupo, com nome e limite, usada em todas as
 * rotas do grupo (o decorator recusa o mesmo grupo com limites diferentes).
 */
export const THROTTLE_GROUPS = {
  hubAuth: { name: 'hub-auth', ...RATE_LIMITS.hubAuth },
  accountRecovery: {
    name: 'account-recovery',
    ...RATE_LIMITS.accountRecoveryIp,
  },
} as const;
