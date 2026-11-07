// Cria um administrador da plataforma (o primeiro: ninguém tem papel para dar o primeiro papel). Spec de papéis da
// plataforma §4.2. Uso, com o login DONO do banco (DB_USERNAME), dentro do container:
//   npm run platform:grant-admin -- <email>
// Idempotente: já sendo admin, não grava nada. Auditado em platform_audit_logs com user_id nulo e via 'cli'.
// TypeScript apagável (Node 24 roda direto, sem compilar): sem imports do projeto, só `pg` e process.loadEnvFile.
import { existsSync } from 'node:fs';
import pg, { type ClientBase } from 'pg';

export type GrantPlatformAdminResult = { userId: string; granted: boolean };

/** Same normalization as the identity (trim -> NFC -> lowercase), so the e-mail matches how it was stored. */
function normalizeEmail(raw: string): string {
  return raw.trim().normalize('NFC').toLowerCase();
}

/** Gives `platform_admin` to the account with this e-mail, in one transaction. Throws if there is no such account. */
export async function grantPlatformAdmin(
  client: ClientBase,
  email: string,
): Promise<GrantPlatformAdminResult> {
  const normalized = normalizeEmail(email);
  await client.query('BEGIN');
  try {
    const users = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL`,
      [normalized],
    );
    const userId = users.rows[0]?.id;
    if (!userId) throw new Error(`No account with the e-mail ${normalized}.`);
    // Mesmo upsert do repositório: cria ou limpa a lápide; já vivo, RETURNING vazio.
    const granted = await client.query(
      `INSERT INTO user_platform_role (user_id, platform_role_id)
       SELECT $1, pr.id FROM platform_roles pr WHERE pr.key = 'platform_admin' AND pr.deleted_at IS NULL
       ON CONFLICT (user_id, platform_role_id) DO UPDATE
          SET deleted_at = NULL, updated_at = now()
        WHERE user_platform_role.deleted_at IS NOT NULL
       RETURNING user_id`,
      [userId],
    );
    if (granted.rowCount) {
      await client.query(
        `INSERT INTO platform_audit_logs (user_id, action, result, target_user_id, metadata)
         VALUES (NULL, 'platform.role.granted', 'success', $1, $2)`,
        [userId, JSON.stringify({ via: 'cli', roleKey: 'platform_admin' })],
      );
    }
    await client.query('COMMIT');
    return { userId, granted: Boolean(granted.rowCount) };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: npm run platform:grant-admin -- <email>');
    process.exit(1);
  }
  if (existsSync('.env')) process.loadEnvFile('.env');
  const client = new pg.Client({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
  });
  await client.connect();
  try {
    const result = await grantPlatformAdmin(client, email);
    console.log(
      result.granted
        ? `platform_admin granted to ${result.userId}.`
        : `${result.userId} is already a platform admin; nothing changed.`,
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (import.meta.main) await main();
