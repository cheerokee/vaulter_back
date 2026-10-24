# CLAUDE.md — Vaulter Back

Orientações para o Claude Code neste repositório. Vale para todo o time: só entra aqui o que é verdade para
qualquer dev. Referências da sua máquina (caminhos, portas, credenciais, repos irmãos) vão no
`CLAUDE.local.md` — veja a seção [Arquivos de contexto](#arquivos-de-contexto).

## Idioma
Responda sempre em português (pt-BR). Código, nomes de variáveis, logs e mensagens de commit seguem em inglês.

## O que é
API backend do Vaulter, em **NestJS 12** + **TypeScript 6** (modo `strict`), rodando em **Node >= 20**
(o time usa Node 24). Repositório: `cheerokee/vaulter_back`.

## Comandos
```bash
npm install          # dependências
npm run start:dev    # API em modo watch (porta: env PORT, padrão 3000)
npm run build        # compila para dist/
npm test             # testes unitários (Vitest)
npm run test:e2e     # testes e2e (Vitest + supertest, config em vitest.config.e2e.ts)
npm run lint         # oxlint com checagem de tipos
npm run format       # Prettier em src/ e test/
```
Antes de dizer que algo está pronto: `npm run build && npm test && npm run lint` precisam passar.

## Stack e convenções
- **ESM puro** (`"type": "module"`, `module: nodenext`): imports relativos levam a extensão `.js`, mesmo
  apontando para arquivos `.ts` — ex.: `import { AppModule } from './app.module.js'`.
- **Testes:** Vitest, não Jest. Globais (`describe`, `it`, `expect`, `vi`) já estão disponíveis via
  `tsconfig`. Unitários ficam ao lado do código (`*.spec.ts`); e2e em `test/` (`*.e2e-spec.ts`).
- **Lint:** oxlint (não ESLint), regras em `.oxlintrc.json`. `no-floating-promises` é erro — sempre `await`
  ou trate a promise.
- **Formatação:** Prettier com aspas simples e trailing comma (`.prettierrc`).
- **Estrutura:** organizar por módulo de domínio do Nest (`src/<modulo>/` com module, controller, service e
  specs). Use o CLI para gerar: `npx nest g resource <nome>`.

## Git
- **Todo o desenvolvimento acontece na `develop`** (branch padrão). Não criar branches de feature nem trocar
  de branch sem o Jonas pedir.
- `main` e `develop` são protegidas contra remoção e force push — nunca usar `push --force`.
- Commits pequenos, no formato Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`...).

## Arquivos de contexto
| Arquivo | Versionado | Para quê |
|---|---|---|
| `CLAUDE.md` | sim | Regras e contexto do projeto, iguais para todos |
| `CLAUDE.local.md` | **não** (`.gitignore`) | Referências da máquina de cada dev |
| `CLAUDE.local-example.md` | sim | Template do `.local` para novos devs |

**Mantenha estes arquivos vivos.** Ao final de uma tarefa que mudou algo descrito aqui (comandos, stack,
convenções, estrutura, fluxo de git), atualize o arquivo certo na mesma entrega:
- mudou para todo mundo → `CLAUDE.md`;
- mudou só na máquina do dev → `CLAUDE.local.md`;
- surgiu um **tipo novo** de referência local (ex.: uma nova variável, um serviço novo para subir) → adicione
  o campo, sem valores reais, também no `CLAUDE.local-example.md`.

Nunca coloque segredos, tokens ou caminhos pessoais no `CLAUDE.md` nem no `CLAUDE.local-example.md`.
