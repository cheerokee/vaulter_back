# CLAUDE.local.md — referências locais (TEMPLATE)

> **Como usar:** copie este arquivo para `CLAUDE.local.md` na raiz do repositório
> (`cp CLAUDE.local-example.md CLAUDE.local.md`) e preencha com os dados da sua máquina.
> O `CLAUDE.local.md` está no `.gitignore` e é lido automaticamente pelo Claude Code junto com o `CLAUDE.md`.
>
> Este template é versionado: quando surgir um tipo novo de referência local, adicione o campo aqui
> (sem valores reais) para os próximos devs.

## Quem sou eu
- Nome:
- Papel no time:
- Preferências de trabalho com o Claude (opcional):

## Ambiente
- SO:
- Node: <!-- saída de `node -v` -->
- npm: <!-- saída de `npm -v` -->
- IDE:

## Caminhos
- Este repositório: <!-- ex.: ~/projetos/vaulter_ai/back -->
- Pasta que reúne os repos do Vaulter: <!-- ex.: ~/projetos/vaulter_ai -->

## Repositórios irmãos
<!-- Outros repos do Vaulter clonados na sua máquina, com caminho local e remoto. Ex.: -->
| Pasta local | Remoto | O que é |
|---|---|---|
|  |  |  |

## Execução local
- Docker / Compose: <!-- saída de `docker --version` e `docker compose version` -->
- Porta da API no host (`API_PORT` no `.env`): <!-- padrão 3000; mude se estiver ocupada -->
- Portas já ocupadas por outros projetos na máquina: <!-- evita conflito ao adicionar serviços -->
- Serviços que precisam estar rodando (banco, filas, etc.): <!-- preencher quando existirem -->
- Onde fica o `.env` e de onde copiar: <!-- nunca colar valores secretos aqui -->

## Observações da máquina
<!-- Qualquer peculiaridade local: portas ocupadas, processos que rodam junto, atalhos, etc. -->
