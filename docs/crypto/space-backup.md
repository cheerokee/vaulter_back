# Objeto cifrado do backup de espaço (formato v1)

Contrato entre app, Hub e backend. Todo conteúdo de um espaço que sobe para o armazenamento (S3) é um **objeto
cifrado**: o app ou o Hub cifra com a **chave do espaço** (versão `keyVersion`, formato das cópias em `user-keys.md`)
e o backend só guarda bytes. Biblioteca: libsodium (`crypto_aead_xchacha20poly1305_ietf`).

## Formato do blob

```
blob = 0x01 ‖ nonce(24) ‖ XChaCha20-Poly1305(plaintext, ad)      (chave = chave do espaço, 32 bytes)
ad   = 0x01 ‖ ASCII "space-object" ‖ spaceId(16) ‖ objectId(16) ‖ keyVersion (uint32 big-endian)
```

| Parte              | Bytes                     |
| ------------------ | ------------------------- |
| byte de versão     | 1                         |
| nonce (aleatório)  | 24                        |
| texto cifrado      | `len(plaintext)` + 16     |
| **overhead total** | **41** (1 + 24 + 16)      |
| `ad`               | 1 + 12 + 16 + 16 + 4 = 49 |

- `spaceId` e `objectId` entram no `ad` como os **16 bytes crus** do UUID (sem hifens, ordem do texto), não como
  texto. `keyVersion` é um inteiro de 32 bits big-endian.
- O `ad` amarra o objeto ao espaço, ao id e à versão da chave: um blob copiado para outro objeto, outro espaço ou
  apresentado com outra versão **não abre** (a autenticação falha).
- Nonce de 24 bytes **aleatório** (CSPRNG) a cada cifragem; nunca reutilizar com a mesma chave.
- O primeiro byte é a **versão do formato**. Quem abre recusa qualquer valor diferente de `0x01`. Mudar o formato
  exige novo byte de versão.
- O rótulo `space-object` **não leva o nome do produto** (fica embutido no dado cifrado para sempre).

## Hash e tamanho

- `sha256` do **blob inteiro** (versão + nonce + texto cifrado), em **hex minúsculo** (64 caracteres). É o que
  o backend guarda e confere no envio; ele não consegue (nem precisa) abrir o conteúdo.
- **Limite de 5 GB por objeto** (teto de um `PutObject` no S3). Conteúdo maior é **dividido pelo Hub** em vários
  objetos, cada um com seu `objectId` e cifrado à parte; a ordem das partes fica no manifesto.

## Manifesto

O manifesto (lista de objetos, ordem das partes, metadados) é **um objeto comum**: mesmo formato, cifrado com
a chave do espaço, com o próprio `objectId`. O backend não distingue manifesto de dado.

## Nada em claro

Nomes de arquivo, tipos, tamanhos reais e qualquer metadado de conteúdo vivem **dentro** de objetos cifrados
(o manifesto). A chave do S3 usa só ids (`orgs/<orgId>/spaces/<spaceId>/...`); o backend só enxerga ids, tamanho
do blob e o `sha256`.

## Vetor de teste

- chave do espaço: bytes `00 01 02 ... 1f` (32 bytes)
- nonce: bytes `20 21 ... 37` (24 bytes)
- `spaceId`: `40414243-4445-4647-4849-4a4b4c4d4e4f` (bytes `40..4f`)
- `objectId`: `50515253-5455-5657-5859-5a5b5c5d5e5f` (bytes `50..5f`)
- `keyVersion`: `1`
- texto: `hello` (UTF-8, 5 bytes)
- `ad` (hex, 49 bytes):
  `0173706163652d6f626a656374404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f00000001`
- blob (hex, 46 bytes):
  `01202122232425262728292a2b2c2d2e2f3031323334353637753c21a714be59b571e563b16d585f9197231329b2`
- blob (base64url): `ASAhIiMkJSYnKCkqKywtLi8wMTIzNDU2N3U8IacUvlm1ceVjsW1YX5GXIxMpsg`
- `sha256` do blob: `b51e337a6468c8af4e936615c6b05b9fe001bb9d0cf8ab1c99e0ab4c47d48b25`

O spec `test/support/space-backup-crypto.spec.ts` confere o vetor (helpers `sealBackupObject`,
`openBackupObject` e `sha256Hex` em `test/support/hub-crypto.ts`).

## Receita do Hub em Python

PyNaCl expõe a mesma primitiva (`nacl.bindings.crypto_aead_xchacha20poly1305_ietf_*`). Receita escrita a partir
do formato acima (o `ad` foi conferido com `struct` para o vetor; a cifragem em si ainda não foi rodada com
PyNaCl, confira com o vetor ao implementar):

```python
import struct, uuid, hashlib
from nacl.bindings import (
    crypto_aead_xchacha20poly1305_ietf_encrypt as enc,
    crypto_aead_xchacha20poly1305_ietf_decrypt as dec,
)

def backup_ad(space_id: str, object_id: str, key_version: int) -> bytes:
    return (b'\x01' + b'space-object' + uuid.UUID(space_id).bytes
            + uuid.UUID(object_id).bytes + struct.pack('>I', key_version))

def seal(key: bytes, space_id, object_id, key_version, plaintext: bytes, nonce: bytes) -> bytes:
    return b'\x01' + nonce + enc(plaintext, backup_ad(space_id, object_id, key_version), nonce, key)

def open_(key: bytes, space_id, object_id, key_version, blob: bytes) -> bytes:
    if blob[0] != 1:
        raise ValueError('unknown version')
    return dec(blob[25:], backup_ad(space_id, object_id, key_version), blob[1:25], key)

sha256_hex = lambda blob: hashlib.sha256(blob).hexdigest()
```

## Versões

Mudar o formato (ordem, `ad`, algoritmo) exige **novo byte de versão** (`0x02`); o servidor guarda blobs
opacos e não interpreta a versão, quem abre recusa as que não conhece.
