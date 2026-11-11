# Manifesto do espaço (formato v1)

Contrato entre o Hub (`vaulter-hub-back`), o app e o backend. O backup de um espaço (`docs/crypto/space-backup.md`) é
uma coleção de objetos cifrados que o backend não lê; o **manifesto** é o objeto que diz **o que é cada objeto**: nome
do arquivo, tipo, origem, data e as partes em ordem. Num espaço em **nuvem ativa** (spec
`docs/superpowers/specs/2026-11-10-active-cloud-design.md` §4.2) a nuvem decifra o manifesto e os arquivos com a chave
do espaço e monta o índice dela (trechos + embeddings); fora da nuvem ativa ninguém além dos membros abre nada.

Este documento é autossuficiente: quem implementa o Hub não precisa ler o código do backend. Os e2e do backend
(`test/support/space-manifest.ts`, `test/cloud/indexing.e2e-spec.ts`) simulam o Hub exatamente com este formato.

## Dois manifestos por espaço

| Manifesto | Quem escreve | `objectId` | Rótulo da derivação |
| --- | --- | --- | --- |
| **do Hub** | o Hub (ou o app de um membro com `memory.write`) | `uuid5(spaceId, "space-manifest/hub")` | `space-manifest/hub` |
| **da nuvem** | **só o servidor** (nuvem ativa) | `uuid5(spaceId, "space-manifest/cloud")` | `space-manifest/cloud` |

- **UUID v5** (RFC 9562 §5.5, SHA-1) com o **`spaceId` como namespace** e o **rótulo como nome** (UTF-8). Quem sabe o
  `spaceId` deriva os dois; isso não revela nada novo (a chave do S3 já carrega o `spaceId`). Os rótulos **não levam o
  nome do produto** (ficam no índice e nos caminhos para sempre).
- Os dois são **objetos comuns do backup**: mesmo formato de blob, mesmas rotas, mesma cota do espaço. O backend aceita
  como `objectId` de envio um **UUID v7** (os objetos do Hub) **ou** o id do manifesto do Hub **daquele espaço**; qualquer
  outro UUID v5 é 422 `object-id-invalid`. O id do manifesto da nuvem é **reservado ao servidor**: enviar ou apagar com ele
  pelas rotas do backup (Hub ou pessoa) é 422 `object-id-reserved`.
- O manifesto do Hub é um objeto como outro qualquer: cada atualização é uma **versão nova do mesmo objeto**
  (`replacesVersionId` = a versão atual), que vai para a lixeira de 30 dias (veja "Tamanho" abaixo).

### Vetor de teste

- `spaceId`: `0195f3a2-7c4e-7b1d-9a3f-2c8e5d4b6a10`
- manifesto do Hub: `8b2a7308-2fac-524e-b218-e264728c6c38`
- manifesto da nuvem: `6a07a309-1c68-5a34-b67f-6b0c8749a005`

Conferido com o `uuid` do Node (`v5(rótulo, spaceId)`) e com o Python (`uuid.uuid5(UUID(spaceId), rótulo)`); o spec
`src/shared/domain/space-manifest-ids.spec.ts` fixa o vetor.

```python
import uuid

HUB_LABEL = "space-manifest/hub"
CLOUD_LABEL = "space-manifest/cloud"

def hub_manifest_id(space_id: str) -> str:
    return str(uuid.uuid5(uuid.UUID(space_id), HUB_LABEL))

def cloud_manifest_id(space_id: str) -> str:
    return str(uuid.uuid5(uuid.UUID(space_id), CLOUD_LABEL))

assert hub_manifest_id("0195f3a2-7c4e-7b1d-9a3f-2c8e5d4b6a10") == "8b2a7308-2fac-524e-b218-e264728c6c38"
assert cloud_manifest_id("0195f3a2-7c4e-7b1d-9a3f-2c8e5d4b6a10") == "6a07a309-1c68-5a34-b67f-6b0c8749a005"
```

## Cifra

O manifesto é cifrado como **qualquer objeto do backup** (`docs/crypto/space-backup.md`, formato v1:
`0x01 ‖ nonce(24) ‖ XChaCha20-Poly1305(plaintext, ad)`, `ad` com `spaceId`, o `objectId` do manifesto e a
`keyVersion`), com a **versão atual** da chave do espaço no momento do envio (a regra do backup: com troca de chave
pendente o envio é recusado e o Hub guarda na fila local). Quem lê usa a `keyVersion` gravada no índice para aquela
versão do objeto; versões antigas de partes e manifestos continuam abrindo com as versões antigas da chave (todo membro
e a nuvem têm a cópia de todas as versões).

## Texto em claro

```
plaintext = 0x01 ‖ UTF-8(JSON)
```

O **primeiro byte é a versão do formato do manifesto** (`0x01`). Quem lê recusa qualquer outro valor; mudança
incompatível = byte novo (`0x02`). Campos novos no JSON (compatíveis) **não** mudam o byte: quem lê ignora campos que
não conhece.

```json
{
  "spaceId": "0195f3a2-7c4e-7b1d-9a3f-2c8e5d4b6a10",
  "writer": "hub",
  "updatedAt": "2026-11-10T12:00:00.000Z",
  "files": [
    {
      "fileId": "0195f3a3-1111-7aaa-8bbb-000000000001",
      "name": "Contrato de fornecimento.docx",
      "path": "Clientes/Orion",
      "mediaType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "source": { "kind": "file" },
      "modifiedAt": "2026-11-09T18:30:00.000Z",
      "sizeBytes": 48211,
      "parts": ["0195f3a3-2222-7aaa-8bbb-0000000000a1", "0195f3a3-2222-7aaa-8bbb-0000000000a2"]
    },
    {
      "fileId": "0195f3a3-1111-7aaa-8bbb-000000000002",
      "name": "Tabela de preços",
      "mediaType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "source": { "kind": "connector", "connector": "google-drive" },
      "parts": ["0195f3a3-2222-7aaa-8bbb-0000000000b1"]
    }
  ]
}
```

| Campo | Regra |
| --- | --- |
| `spaceId` | obrigatório; igual ao espaço do objeto (senão o manifesto inteiro é recusado) |
| `writer` | obrigatório; `"hub"` no manifesto do Hub, `"cloud"` no da nuvem (o outro valor: recusado) |
| `updatedAt` | ISO 8601 UTC terminando em `Z`; informativo |
| `files` | obrigatório; lista (vazia vale: espaço sem arquivos); até **100 000** arquivos |
| `files[].fileId` | obrigatório; **UUID v7** gerado por quem criou o arquivo; **estável** pela vida do arquivo (renomear, mover e editar mantêm o `fileId`) |
| `files[].name` | obrigatório; 1..255 caracteres; o nome mostrado (com extensão quando houver) |
| `files[].path` | opcional (`null` ou ausente = raiz); até 1024 caracteres; pastas separadas por `/`, sem o nome |
| `files[].mediaType` | obrigatório; tipo MIME (`tipo/subtipo`); parâmetros (`; charset=...`) são ignorados; é ele que escolhe o extrator (não a extensão) |
| `files[].source` | obrigatório; `{ "kind": "file" }` (arquivo do espaço), `{ "kind": "connector", "connector": "<id>" }` (espelho de conector; `connector` em minúsculas, `[a-z0-9._-]`, até 100) ou `{ "kind": "cloud" }` (documento gravado pela nuvem) |
| `files[].modifiedAt` | opcional; ISO 8601 UTC com `Z`; última modificação do arquivo |
| `files[].sizeBytes` | opcional, informativo; tamanho do arquivo em claro |
| `files[].parts` | obrigatório; 1..**1000** `objectId`s (UUID v7) **distintos**, **na ordem**; o arquivo = a concatenação dos textos em claro das partes nessa ordem |

- **Uma entrada inválida** (campo obrigatório faltando ou fora da regra) ou um **`fileId` repetido** no mesmo manifesto
  derruba **só aquela entrada** (a primeira ocorrência de um `fileId` vale); o resto é lido.
- **O manifesto inteiro é recusado** quando o byte de versão, o JSON (UTF-8 inválido incluído), `spaceId`, `writer` ou
  `files` estão errados, ou quando passa dos limites abaixo. Recusado = a nuvem **mantém o índice como estava** e
  registra só ids e um código; a próxima versão válida do manifesto corrige.
- Nomes, caminhos e tipos existem **só dentro do manifesto cifrado** (e, na nuvem ativa, nas tabelas legíveis da nuvem,
  apagadas ao desligar). Nunca em chave do S3, log ou campo em claro.

## O que nunca entra no manifesto

O manifesto lista **só documentos do espaço**: arquivos (`source.kind = "file"`), espelhos de conector (`"connector"`,
só em nuvem ativa) e documentos da nuvem (`"cloud"`). **É proibido** listar nele qualquer objeto interno do Hub que
também vai para o backup: **assuntos (conversas) e suas mensagens/anexos, eventos, pedaços do índice local
(embeddings, banco vetorial), estado do aparelho, filas, logs, cópias de conflito internas**, ou qualquer objeto que não
seja o conteúdo de um documento que todos os membros do espaço podem ler. O motivo: num espaço em nuvem ativa a nuvem
indexa tudo o que o manifesto lista **para todos os membros do espaço**; uma conversa privada listada aqui vazaria pelo
RAG. Esses objetos internos existem no backup só com o `objectId` deles e **nunca** aparecem no manifesto.

Guardas do servidor (a nuvem não depende só do Hub; nenhuma delas substitui a regra acima):
- só `source.kind` `file`, `connector` ou `cloud` são aceitos; qualquer outro valor derruba a entrada;
- cada parte tem de ser um objeto comum **vivo deste espaço** no índice do backup (UUID v7; os ids dos manifestos não são
  partes; objeto de outro espaço, apagado ou não confirmado deixa o arquivo fora do índice);
- **um objeto pertence a um documento só**: entradas (dos dois manifestos juntos, depois da união por `fileId`) que
  compartilham qualquer parte com outra entrada são **todas** descartadas (registro só com a contagem);
- só os tipos da tabela "Formatos indexados" têm o texto extraído; qualquer outro tipo fica fora do índice;
- os anexos e mensagens dos assuntos ficam num índice próprio (`conversation_attachments`, corpo cifrado nas mensagens),
  fora do índice do backup: não podem ser parte de um arquivo do manifesto.

## Partes e ordem

- Arquivo até 5 GiB cifrado: **uma parte** (o objeto do arquivo). Maior: o Hub divide o arquivo **em claro** em pedaços
  consecutivos, cifra **cada pedaço como um objeto** (seu próprio `objectId` v7, sua própria cifra com o `ad` daquele
  `objectId`) e lista os `objectId`s em ordem em `parts`. Quem lê junta os textos em claro na ordem e só então
  interpreta o arquivo (um docx dividido em duas partes é um zip só depois de juntar).
- Arquivo atualizado: **versões novas dos mesmos objetos** quando o número de partes não muda (o manifesto não precisa
  mudar, além de `modifiedAt`); se o número de partes mudar, objetos novos e o manifesto novo, e os objetos que sobraram
  são **apagados** do backup.
- **Ordem de envio:** primeiro as partes (intenção, PUT, confirmação), **depois** o manifesto que as lista. Uma parte
  listada que ainda não está confirmada (ou foi apagada) deixa o arquivo **fora do índice** até ela chegar (a nuvem tira
  os trechos dele na hora, para não responder com conteúdo pela metade).
- **Apagar um arquivo:** apagar os objetos das partes **e** enviar o manifesto sem ele (qualquer um dos dois já tira os
  trechos; os dois mantêm a restauração coerente).

## Tamanho

- O manifesto vai para a lixeira a cada versão (30 dias, conta no uso; spec storage-backup §4.8, até 10 versões antigas
  por objeto): mantenha-o **pequeno** e **envie só quando mudar** (compare o sha256). Ordem de grandeza: ~250 bytes por
  arquivo (100 000 arquivos ≈ 25 MB).
- **Limites de leitura da nuvem** (`src/cloud/domain/indexing-limits.ts`): manifesto (blob) até **64 MiB**; arquivo
  indexado até **100 MiB** em claro (soma das partes; maior fica só no backup, sem trechos, com o motivo `too-large`);
  até **5 000 000** caracteres de texto extraído por arquivo (o resto é descartado); docx/xlsx: até 10 000 entradas no
  zip, 64 MiB por entrada lida, 128 MiB lidos no total e taxa de compressão até 200:1 (acima disso: `unreadable`).

## Formatos indexados (v1)

Escolhidos pelo `mediaType` (spec active-cloud §4.2):

| `mediaType` | O que a nuvem lê |
| --- | --- |
| `application/pdf` | a camada de texto de cada página (sem OCR: página escaneada não dá texto) |
| `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (docx) | o texto de `word/document.xml`, um parágrafo por `w:p` |
| `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (xlsx) | cada planilha na ordem do livro: o nome e uma linha por parágrafo (valores como gravados) |
| `text/csv` | uma linha por parágrafo |
| `text/markdown`, `text/plain` | o texto como está |
| `text/html` | o texto visível (sem `script`/`style`), um parágrafo por bloco |

Texto (`text/*`) é **UTF-8**. Qualquer outro tipo (imagem, áudio, `.doc`/`.xls` antigos...) fica no backup e **não**
entra no índice (`unsupported-format`, registrado só com ids e o tipo). Espelhos de conector (Google Docs, Notion...)
entram exportados para um destes tipos.

## Trechos e embeddings

- **Modelo:** `nomic-embed-text` (768 dimensões), o **mesmo do Hub**, **sem prefixo de tarefa** (o Hub,
  `index_docs.py`, embute o texto puro). O modelo usado fica gravado em cada trecho. Adotar os prefixos
  `search_document: ` / `search_query: ` que a nomic recomenda é uma **mudança conjunta** (Hub e nuvem no mesmo
  release, com reindexação completa dos dois lados), porque vetores com e sem prefixo não se comparam bem.
- **Divisão em trechos:** a do Hub (`chunk_text`): parágrafos (separados por linha em branco) agrupados até **800**
  caracteres, unidos por linha em branco; parágrafo maior cortado em pedaços fixos de 800; sem sobreposição; trechos
  menores que **80** caracteres descartados, exceto quando são o único texto do arquivo. A nuvem não usa os vetores do
  Hub (cada lado calcula os seus), mas o mesmo modelo e a mesma divisão mantêm as respostas coerentes entre os dois.

## Como a nuvem usa os manifestos

- A nuvem lê **os dois** manifestos (sempre a versão que o índice do backup diz, nunca a "atual" do S3) e une as
  entradas por `fileId`; **a do Hub vence** a da nuvem.
- Cada confirmação ou apagamento de objeto num espaço em nuvem ativa dispara uma **passada** (com 2 s de espera, para
  juntar uma rajada de envios): arquivo novo, ou com **alguma parte numa versão nova**, é reindexado; arquivo cujas
  partes não mudaram fica como está (renomear só atualiza o nome); arquivo que saiu dos manifestos perde os trechos.
- Ligar a nuvem indexa tudo; desligar **apaga** de verdade os trechos, os embeddings, os nomes e a cópia da chave do
  servidor (o backup cifrado não muda).
- **Conversas (assuntos) nunca entram** no índice do espaço (são privadas de quem participa): veja "O que nunca entra
  no manifesto".
- Extração numa thread separada, com limite de tempo (60 s por arquivo) e de memória (1 GiB de heap): arquivo que
  estoura, não abre ou não parseia fica `unreadable` e **não é tentado de novo** até chegar uma versão nova dele.

## Manifesto da nuvem e incorporação pelo Hub

Os documentos que a nuvem grava (decisões, atas, convenções: spec active-cloud §4.3; escrito pela Task 7) são objetos
comuns do backup (UUID v7, cifrados com a chave do espaço, contando no tamanho do espaço) listados **só** no manifesto
da nuvem, com `"writer": "cloud"` e `source: { "kind": "cloud" }`. O Hub é o dono dos arquivos e do manifesto dele;
para não haver dois escritores no mesmo manifesto:

1. O Hub lê o manifesto da nuvem a cada sincronização do backup (listagem, §9 de `hub-lifecycle.md`; o objeto do
   manifesto da nuvem aparece como qualquer outro, com o id derivado acima).
2. Para cada entrada que **não** está no manifesto dele: baixa as partes (abrem com a chave do espaço, como qualquer
   objeto), guarda o arquivo localmente e o acrescenta ao **seu** manifesto **com o mesmo `fileId` e os mesmos
   `objectId`s** (não reenvia os bytes: os objetos já estão no backup). O `source` pode continuar `{ "kind": "cloud" }`
   (a origem do documento) ou passar a `file`.
3. Envia o manifesto do Hub atualizado.
4. O servidor, ao ver o `fileId` no manifesto do Hub, **tira a entrada do manifesto da nuvem** (o Hub nunca escreve
   nele). Enquanto as duas listas têm o `fileId`, vale a do Hub. (A escrita do manifesto da nuvem, inclusive este
   passo, entra junto com os documentos gravados pela nuvem; até lá o manifesto da nuvem não existe.)

Daí em diante o arquivo é do Hub como outro qualquer (editar, mover, apagar). Se o Hub nunca voltar (roubado), o
manifesto da nuvem continua listando os documentos e nada some numa reindexação.

## Espelhos de conector no backup

- **Só nos espaços em nuvem ativa** (`cloudMode = "active_cloud"` no item `space` da sincronização do Hub, `GET
  /hub/sync`) o Hub **envia ao backup** os espelhos de conector (cifrados como o resto, `source.kind = "connector"`),
  para a nuvem indexá-los. Nos outros espaços eles continuam **fora** do backup (spec de produto §10).
- Quando o espaço sai da nuvem ativa, o Hub **para de enviar** espelhos e **apaga do backup** os que tinha enviado
  (objetos e entradas do manifesto); eles ficam 30 dias na lixeira cifrada, sem cópia da chave no servidor.

## Versões

- Byte `0x01` = este documento. Campo novo e compatível: mesmo byte, documento atualizado. Mudança de forma, de regra de
  leitura ou de limite que o Hub precisa respeitar: byte novo e uma fase em que a nuvem lê os dois.
- Mudou este contrato (campos, limites, formatos, rótulos): atualize `docs/hubs/hub-lifecycle.md` e avise a sessão do
  `vaulter-hub-back` na mesma entrega.
