# Identidade criptográfica do Hub (formato v1)

Contrato entre backend e Hub. O Hub tem **dois pares de chaves**, gerados nele e guardados só nele:

- **assinatura**: Ed25519 (`crypto_sign_keypair`), prova que a mensagem veio do Hub;
- **cifra**: X25519 (`crypto_box_keypair`), recebe as cópias trancadas das chaves de espaço (formato em
  `user-keys.md`).

Biblioteca: libsodium. Chaves públicas têm 32 bytes.

## Codificação

Todo binário trafega em JSON e cabeçalhos como **base64url sem padding** (`URLSAFE_NO_PADDING`); decodificadores
**rejeitam** `=`, `+` e `/` e qualquer texto que não seja a codificação canônica.

| Campo                                     | Bytes | Caracteres |
| ----------------------------------------- | ----- | ---------- |
| `signingPublicKey`, `encryptionPublicKey` | 32    | 43         |
| `nonce` (apresentação)                    | 16    | 22         |
| `challenge`                               | 32    | 43         |
| assinatura                                | 64    | 86         |

## Mensagem assinada

```
bytes = UTF-8(rótulo) ‖ 0x00 ‖ UTF-8(JSON canônico dos campos)
assinatura = crypto_sign_detached(bytes, chavePrivadaDeAssinatura)
```

- **JSON canônico**: chaves ordenadas recursivamente (por unidades de código UTF-16), sem espaços, sem campos
  extras (a ordem de entrada não importa). Implementação única: `src/hubs/domain/hub-signed-message.ts`.
- O **rótulo** separa os usos: uma assinatura de um rótulo não vale em outro. Rótulos **não levam o nome do
  produto**.
- **Escape (v1):** todos os campos v1 são **strings ASCII que não precisam de escape** (base64url, UUID, dígitos e o
  timestamp); nenhum campo v1 é número, booleano, `null`, objeto aninhado ou texto livre. Por isso a serialização
  é exatamente `{"chave":"valor",...}`, sem `\` em lugar nenhum. Texto não ASCII **não é usado no v1**: se um rótulo
  futuro levar texto livre, ele define as regras de escape (e de normalização Unicode) junto com o novo rótulo.
- **Timestamp:** ISO 8601 em UTC terminando em **`Z`**, nunca `+00:00` (o servidor recusa com 422
  `timestamp-invalid`), com **no máximo 3 casas** de fração de segundo (ex.: `2026-11-01T12:00:00.000Z` ou
  `2026-11-01T12:00:00Z`). O texto assinado é o mesmo texto enviado: o servidor não reformata o timestamp.
- **Receita do Hub em Python** (gera, para o vetor abaixo, o mesmo JSON canônico do backend; conferido):

  ```python
  import json
  from datetime import datetime, timezone

  def canonical_json(fields: dict) -> str:
      return json.dumps(fields, sort_keys=True, separators=(',', ':'), ensure_ascii=False)

  def hub_timestamp() -> str:
      # isoformat() sozinho dá microssegundos e '+00:00': os dois são recusados
      return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')

  signed_bytes = label.encode('utf-8') + b'\x00' + canonical_json(fields).encode('utf-8')
  ```

  `sort_keys` ordena por ponto de código e o JavaScript por unidades UTF-16: para as chaves ASCII do v1 é a mesma
  ordem. `ensure_ascii=False` não muda nada no v1 (só ASCII); ele está na receita para o Python nunca produzir
  `\uXXXX` onde o JavaScript produziria o caractere.

| Rótulo          | Campos assinados                                                | Uso                 |
| --------------- | --------------------------------------------------------------- | ------------------- |
| `hub-enroll-v1` | `signingPublicKey`, `encryptionPublicKey`, `nonce`, `timestamp` | apresentação do Hub |
| `hub-status-v1` | `enrollmentId`, `timestamp`                                     | consulta de status  |
| `hub-auth-v1`   | `hubId`, `challenge`                                            | autenticação do Hub |

- `timestamp`: ISO 8601 UTC terminando em `Z` (veja acima); o servidor aceita **±5 min** do relógio dele.
- `nonce`: 16 bytes aleatórios, de uso único por `signingPublicKey`.
- Assinatura ou chave malformada, ou que não confere: a verificação devolve falso (nunca erro), e a rota
  responde sempre igual.

## Código de reivindicação e desafio

- **Código**: 8 dígitos decimais de um CSPRNG, sem viés de módulo (`randombytes_uniform(100000000)`),
  preenchidos com zeros à esquerda. Vale 10 min. O banco guarda só
  `hex(crypto_generichash(32, "hub-claim-code-v1" ‖ 0x00 ‖ código, HUB_CODE_HASH_KEY))`; a chave é um segredo do
  servidor (32 bytes base64url no `.env`), para um banco vazado não permitir testar os 10^8 códigos.
- **Desafio**: 32 bytes aleatórios em base64url, uso único, vale 60 s. O banco guarda
  `hex(crypto_generichash(32, "hub-auth-challenge-v1" ‖ 0x00 ‖ desafio, HUB_CODE_HASH_KEY))`. A mesma chave
  serve aos dois, e o prefixo (separação de domínio) impede que um hash de um valha para o outro.

## Vetor de teste

Semente: bytes `00 01 02 ... 1f` (32 bytes). Chaves: `crypto_sign_seed_keypair(semente)` e
`crypto_box_seed_keypair(semente)`.

- `signingPublicKey`: `A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg`
- `encryptionPublicKey`: `RwHQhIhFH1RaQJ-1iuPlhYHKQKw_fxFGmM1x3qxzygE`
- `nonce` (bytes `00..0f`): `AAECAwQFBgcICQoLDA0ODw`
- `timestamp`: `2026-11-01T12:00:00.000Z`
- rótulo: `hub-enroll-v1`
- JSON canônico:

```
{"encryptionPublicKey":"RwHQhIhFH1RaQJ-1iuPlhYHKQKw_fxFGmM1x3qxzygE","nonce":"AAECAwQFBgcICQoLDA0ODw","signingPublicKey":"A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg","timestamp":"2026-11-01T12:00:00.000Z"}
```

- assinatura (base64url): `8wQttPW9-f7bcvb-5wDeT6bwGU8ZHApDzVzrIPUCBmu79BY7I48NLHSkt20zeXRvzwBAYj8zOahLR-t4Si94Ag`
- assinatura (hex): `f3042db4f5bdf9fedb72f6fee700de4fa6f0194f191c0a43cd5ceb20f502066bbbf4163b238f0d2c74a4b76d3379746fcf0040623f3339a84b47eb784a2f7802`

Ed25519 é determinístico: a mesma entrada gera sempre esta assinatura. O spec
`sodium-hub-signature-verifier.spec.ts` confere o vetor.

## Versões

Mudar campos ou a serialização exige **novo rótulo** (`...-v2`); o servidor aceita só os rótulos que conhece.
