# Cifra das conversas (formato v1)

Contrato entre app, Hub e backend para o conteúdo das conversas (assuntos): **cabeçalho**, **mensagens** e **anexos**.
O app ou o Hub cifra; o backend só guarda bytes e valida o formato. Biblioteca: libsodium
(`crypto_aead_xchacha20poly1305_ietf`, `crypto_box_seal`). Mesmo estilo de `space-backup.md` e `user-keys.md`.

## A chave é da conversa, nunca do espaço

Cada conversa tem a **própria chave**, de 32 bytes aleatórios (CSPRNG), em **versões** (`keyVersion`, inteiro >= 1).
**Nunca** se cifra conteúdo de conversa com a chave do espaço: quem lê o espaço não lê, por isso, uma conversa
privada. A chave da conversa é independente da chave do espaço e de qualquer outra conversa.

### Cópias trancadas da chave

Cada participante (e o kit de recuperação, quando couber) recebe uma **cópia trancada** de cada versão, no mesmo
formato das cópias da chave do espaço (`user-keys.md`):

```
copy = 0x01 ‖ crypto_box_seal(chave da conversa, chave pública X25519 do destinatário)
```

81 bytes, em base64url sem padding: **108 caracteres** (`^[A-Za-z0-9_-]{108}$`). Quem abre recusa versão diferente
de `0x01`.

## Formato do blob (cabeçalho, mensagem e anexo)

```
blob = 0x01 ‖ nonce(24) ‖ XChaCha20-Poly1305(plaintext, ad)      (chave = chave da conversa na versão keyVersion)
ad   = 0x01 ‖ ASCII rótulo ‖ spaceId(16) ‖ conversationId(16) ‖ recordId(16) ‖ keyVersion (uint32 big-endian)
```

| Uso        | Rótulo (ASCII)            | `recordId`           |
| ---------- | ------------------------- | -------------------- |
| cabeçalho  | `conversation-header`     | `conversationId`     |
| mensagem   | `conversation-message`    | id da mensagem       |
| anexo      | `conversation-attachment` | id do anexo          |

| Parte              | Bytes                                         |
| ------------------ | --------------------------------------------- |
| byte de versão     | 1                                             |
| nonce (aleatório)  | 24                                            |
| texto cifrado      | `len(plaintext)` + 16                         |
| **overhead total** | **41** (1 + 24 + 16)                          |
| `ad`               | 1 + len(rótulo) + 16 + 16 + 16 + 4            |

`ad` mede 72 bytes (cabeçalho, rótulo de 19), 73 (mensagem, 20) e 76 (anexo, 23).

- Os três ids entram no `ad` como os **16 bytes crus** do UUID (sem hifens, ordem do texto), não como texto.
  `keyVersion` é um inteiro de 32 bits big-endian.
- O `ad` amarra o blob ao espaço, à conversa, ao registro, à versão da chave e ao **uso**: um blob copiado para outra
  mensagem, outra conversa, outro espaço, apresentado com outra versão ou sob outro rótulo (uma mensagem aberta como
  anexo, por exemplo) **não abre** (a autenticação falha).
- Nonce de 24 bytes **aleatório** (CSPRNG) a cada cifragem; nunca reutilizar com a mesma chave.
- O primeiro byte é a **versão do formato**; quem abre recusa qualquer valor diferente de `0x01`.
- Os rótulos **não levam o nome do produto** (ficam embutidos no dado cifrado para sempre).
- Anexo: o blob é o objeto enviado ao S3 pelo mesmo mecanismo do backup (`space-backup.md`: `sha256` do blob
  inteiro em hex minúsculo, que o backend guarda e confere), mas cifrado com a chave da **conversa** e o rótulo
  `conversation-attachment`.

## Nada em claro

Título, plano, texto, nome e tipo de arquivo e qualquer metadado de conteúdo vivem **dentro** de blobs cifrados.
O backend só enxerga ids, `keyVersion`, tamanhos e o `sha256` dos anexos.

## Vetor de teste

- chave da conversa: bytes `00 01 02 ... 1f` (32 bytes)
- nonce: bytes `20 21 ... 37` (24 bytes)
- `spaceId`: `40414243-4445-4647-4849-4a4b4c4d4e4f` (bytes `40..4f`)
- `conversationId`: `50515253-5455-5657-5859-5a5b5c5d5e5f` (bytes `50..5f`)
- `recordId` (mensagem e anexo): `60616263-6465-6667-6869-6a6b6c6d6e6f` (bytes `60..6f`); no cabeçalho, `conversationId`
- `keyVersion`: `1`
- texto: `hello` (UTF-8, 5 bytes); cada blob tem 46 bytes

Cabeçalho:

- `ad` (hex, 72 bytes):
  `01636f6e766572736174696f6e2d686561646572404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f505152535455565758595a5b5c5d5e5f00000001`
- blob (hex):
  `01202122232425262728292a2b2c2d2e2f3031323334353637753c21a71483c8a9e77d1e1db831a358da9a0c3198`
- blob (base64url): `ASAhIiMkJSYnKCkqKywtLi8wMTIzNDU2N3U8IacUg8ip530eHbgxo1jamgwxmA`

Mensagem:

- `ad` (hex, 73 bytes):
  `01636f6e766572736174696f6e2d6d657373616765404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f00000001`
- blob (hex):
  `01202122232425262728292a2b2c2d2e2f3031323334353637753c21a714d532f25e7fe9f2540a388d3d8e22942e`
- blob (base64url): `ASAhIiMkJSYnKCkqKywtLi8wMTIzNDU2N3U8IacU1TLyXn_p8lQKOI09jiKULg`

Anexo:

- `ad` (hex, 76 bytes):
  `01636f6e766572736174696f6e2d6174746163686d656e74404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f00000001`
- blob (hex):
  `01202122232425262728292a2b2c2d2e2f3031323334353637753c21a7143a4649e3daad5f7c5e708ad45a8f03d9`
- blob (base64url): `ASAhIiMkJSYnKCkqKywtLi8wMTIzNDU2N3U8IacUOkZJ49qtX3xecIrUWo8D2Q`

O spec `test/support/conversation-crypto.spec.ts` confere o vetor (helpers `sealHeader`/`openHeader`,
`sealMessage`/`openMessage`, `sealAttachment`/`openAttachment`, `newConversationKey`, `sealConversationKey` e
`openConversationKey` em `test/support/conversation-crypto.ts`). O vetor foi calculado por um script à parte, que
monta o `ad` com `Buffer` sem passar pelos helpers, e os dois resultados coincidem.

## Receita do Hub em Python

PyNaCl expõe a mesma primitiva (`nacl.bindings.crypto_aead_xchacha20poly1305_ietf_*`). Receita escrita a partir do
formato acima. **PyNaCl não estava instalado quando este documento foi escrito**, então a cifragem em si ainda não
foi rodada com ele (o vetor foi conferido com libsodium em Node); confira com o vetor ao implementar:

```python
import struct, uuid
from nacl.bindings import (
    crypto_aead_xchacha20poly1305_ietf_encrypt as enc,
    crypto_aead_xchacha20poly1305_ietf_decrypt as dec,
)

LABELS = {'header': b'conversation-header', 'message': b'conversation-message',
          'attachment': b'conversation-attachment'}

def conv_ad(kind: str, space_id: str, conversation_id: str, record_id: str, key_version: int) -> bytes:
    # no cabeçalho, record_id == conversation_id
    return (b'\x01' + LABELS[kind] + uuid.UUID(space_id).bytes + uuid.UUID(conversation_id).bytes
            + uuid.UUID(record_id).bytes + struct.pack('>I', key_version))

def seal(key: bytes, kind, space_id, conversation_id, record_id, key_version, plaintext: bytes, nonce: bytes) -> bytes:
    ad = conv_ad(kind, space_id, conversation_id, record_id, key_version)
    return b'\x01' + nonce + enc(plaintext, ad, nonce, key)

def open_(key: bytes, kind, space_id, conversation_id, record_id, key_version, blob: bytes) -> bytes:
    if blob[0] != 1:
        raise ValueError('unknown version')
    ad = conv_ad(kind, space_id, conversation_id, record_id, key_version)
    return dec(blob[25:], ad, blob[1:25], key)
```

## Versões

Mudar o formato (ordem, `ad`, algoritmo, rótulos) exige **novo byte de versão** (`0x02`); o servidor guarda blobs
opacos e não interpreta a versão, quem abre recusa as que não conhece.
