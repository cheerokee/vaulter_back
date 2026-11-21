import { MigrationInterface, QueryRunner } from 'typeorm';

// Termo que cobre o agente do PC (spec pc-agent §5.8): `cloud_terms.covers_agent` diz se a versão cobre o envio ao
// modelo de dados do PC (resultados de ferramentas, páginas do navegador, arquivos da pasta liberada). A v1 (e toda
// versão anterior) fica `false`; a v2 abaixo cobre. Publicada só por migration, como as outras versões (o runtime só
// lê). O termo atual é a maior versão, então quem só aceitou a v1 precisa aceitar a v2 para autorizar a nuvem ou usar
// o agente. A v2 é um RASCUNHO provisório: o texto final do Jonas entra como versão nova. `hash` = SHA-256 hex do
// texto em UTF-8.

const TERM_V2 = `RASCUNHO PROVISÓRIO — NÃO É O TEXTO FINAL. Substituir pela versão aprovada pelo jurídico antes de produção.

Termo de aceite da nuvem ativa e do agente no PC (versão 2, provisória)

Ao ligar a nuvem ativa num espaço, a organização autoriza o serviço a ler o conteúdo desse espaço: o servidor recebe
uma cópia da chave do espaço, decifra o backup, extrai o texto dos arquivos, calcula embeddings e usa um modelo de
linguagem (Claude, pela Amazon Bedrock, na região us-east-1) para responder perguntas dos membros. Os dados não são
usados para treinar modelos.

Desligar a nuvem ativa apaga do servidor a cópia da chave e todo o conteúdo legível derivado do espaço; o backup
cifrado continua como estava.

O uso é medido e limitado pelo orçamento mensal de IA da organização.

Agente no PC: quando um PC age como Hub, os dados do PC que o agente lê durante a conversa (resultados de ferramentas,
páginas do navegador e arquivos da pasta liberada) são enviados ao modelo de linguagem para que ele responda. Esses
dados não são guardados no servidor além do necessário para a resposta e não são usados para treinar modelos.`;

export class CloudTermsCoverAgent1792898900000 implements MigrationInterface {
  name = 'CloudTermsCoverAgent1792898900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "cloud_terms"
        ADD COLUMN "covers_agent" boolean NOT NULL DEFAULT false
    `);
    await queryRunner.query(
      `INSERT INTO "cloud_terms" ("version", "hash", "text", "published_at", "covers_agent")
       VALUES (2, encode(sha256(convert_to($1::text, 'UTF8')), 'hex'), $1::text, now(), true)`,
      [TERM_V2],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "cloud_terms" WHERE "version" = 2`);
    await queryRunner.query(`
      ALTER TABLE "cloud_terms" DROP COLUMN "covers_agent"
    `);
  }
}
