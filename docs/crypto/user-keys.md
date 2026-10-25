# Material criptográfico do usuário (formato v1)

Contrato entre backend, app e hub. O backend **nunca vê a senha**: o cliente deriva uma chave mestra com
Argon2id e, dela, uma **prova de login** (enviada ao servidor) e uma **chave de cifra** (que nunca sai do
aparelho) que tranca a chave privada X25519 do usuário. Biblioteca: libsodium em todos os clientes.

## Codificação

Todo binário trafega em JSON como **base64url sem padding** (`URLSAFE_NO_PADDING`). Sem `=`, `+` ou `/`:
decodificadores devem **rejeitar** `=` e os caracteres `+` e `/`.

| Campo                 | Bytes | Caracteres |
| --------------------- | ----- | ---------- |
| `kdfSalt`             | 16    | 22         |
| `authProof`           | 32    | 43         |
| `publicKey`           | 32    | 43         |
| `encryptedPrivateKey` | 73    | 98         |

## Derivação

1. `kdfSalt`: 16 bytes aleatórios (`crypto_pwhash_SALTBYTES`), gerados no cadastro e a cada troca de senha.
2. `kdfParams`: exatamente `{ "algorithm": "argon2id13", "opsLimit": int, "memLimitBytes": int }`, sem outras
   chaves.
   - `opsLimit`: 2 a 10. `memLimitBytes`: 67108864 (64 MiB) a 1073741824 (1 GiB).
   - Padrão: `opsLimit` 3, `memLimitBytes` 67108864. É o que o pré-login devolve para e-mail inexistente.
3. Chave mestra: `crypto_pwhash(32, senha, kdfSalt, opsLimit, memLimitBytes, crypto_pwhash_ALG_ARGON2ID13)`.
   **Parâmetros:** o app deve **sempre registrar com `DEFAULT_KDF_PARAMS`**: parâmetros diferentes do padrão
   tornam a conta distinguível no pré-login (o e-mail inexistente devolve o padrão).

   **E-mail:** o cliente normaliza como o servidor: `trim()`, depois `normalize('NFC')`, depois `toLowerCase()`
   (o resultado precisa ter de 1 a 255 caracteres; o servidor valida o tamanho depois da normalização).

   **Senha:** `senha.normalize('NFC')` e então bytes UTF-8, **sem `trim`** (assim a mesma senha digitada em
   teclados ou sistemas com normalização diferente gera a mesma chave).
4. Subchaves, com `crypto_kdf_derive_from_key(32, id, "acctkeys", chaveMestra)` (`id` é `uint64`; o contexto
   tem exatamente 8 bytes ASCII):
   - `id = 1`: **`authProof`** (vai ao servidor, que a guarda como hash Argon2id);
   - `id = 2`: **chave de cifra** (nunca sai do aparelho).
5. O contexto `"acctkeys"` é fixo e não leva o nome do produto.

## Chaves e blob trancado

- `publicKey`: chave pública X25519 crua (`crypto_box_keypair`), 32 bytes.
- `encryptedPrivateKey` (73 bytes):

```
0x01 ‖ nonce (24) ‖ ciphertext+tag (48)
```

`ciphertext+tag = crypto_aead_xchacha20poly1305_ietf_encrypt(privateKey (32), ad = 0x01, nonce, chaveDeCifra)`,
no modo combinado da libsodium: ciphertext (32) ‖ tag (16). O dado associado `ad` é o **byte único `0x01`**.
O **primeiro byte é a versão do formato** (`0x01`). Versão diferente
de `0x01` deve ser rejeitada; mudar o formato exige novo byte de versão.

- O backend valida tamanhos, versão e faixas, mas não abre o blob.

## Fluxos

- **Cadastro:** gerar salt, escolher `kdfParams`, derivar, gerar o par X25519, trancar a privada, enviar
  `kdfSalt`, `kdfParams`, `authProof`, `publicKey`, `encryptedPrivateKey`.
- **Login:** pedir o pré-login (devolve `kdfSalt` e `kdfParams`; para e-mail inexistente devolve um salt falso
  estável e os parâmetros padrão), derivar, enviar `authProof`. Em seguida abrir `encryptedPrivateKey`
  localmente.
- **Login offline no hub (§5.0 da spec de contas):** a prova da senha é **abrir a chave privada**. O hub guarda
  (enquanto online) `kdfSalt`, `kdfParams` e `encryptedPrivateKey` dos membros das organizações vinculadas,
  deriva a chave mestra localmente e tenta abrir o blob; se abrir, a senha está certa. Vale por até 30 dias
  desde a última sincronização. Senha trocada ou acesso removido com o hub offline só passam a valer ali na
  próxima sincronização. Limite aceito: quem levar o SSD pode testar senhas offline contra a chave privada;
  quem protege é o LUKS, a KDF lenta e uma força mínima de senha.
- **Troca de senha:** a **mesma chave privada** é trancada de novo com **novo salt** (e nova chave mestra). O
  cliente envia a prova atual e o novo material (`kdfSalt`, `kdfParams`, `authProof`, `encryptedPrivateKey`).
  A `publicKey` não muda, então as chaves de espaço trancadas para o usuário continuam abrindo. As demais
  sessões do usuário são revogadas.
- **Recuperação de senha por e-mail:** devolve o **login, não os dados**. A chave privada só abre com a senha.
  O kit de recuperação da organização reabre os espaços, não a chave pessoal. Quem está sozinho e perde senha
  e kit perde o que está cifrado.

## Sessões e refresh

O refresh token é rotativo: cada uso invalida o anterior, e reapresentar um token já usado conta como **reuso**
e revoga a sessão. Por isso o cliente **deve serializar as chamadas de refresh** (uma de cada vez, com fila ou
mutex) e reaproveitar o resultado para as requisições que esperam. Dois refreshes simultâneos com o mesmo token
derrubam a sessão.

## Implementação de referência

`test/support/client-crypto.ts` simula o lado do cliente com libsodium e segue este documento byte a byte.

## Vetor de teste (v1)

Valores **somente para teste**, fixados em `test/support/client-crypto.spec.ts`.

- senha (Unicode, NFC): `pásswörd-ção` (`p\u00e1ssw\u00f6rd-\u00e7\u00e3o`)
- `kdfSalt` (hex): `000102030405060708090a0b0c0d0e0f` (base64url: `AAECAwQFBgcICQoLDA0ODw`)
- `kdfParams`: `argon2id13`, `opsLimit` 2, `memLimitBytes` 67108864
- `authProof` (hex): `fa19859a223eab1569716ecf6c992e08022e1885a40c7986426ce53366e25310`
- chave de cifra (hex, valor de teste, nunca trafega): `2fc44862c075b832b88eab5bb8eda4f644d761d6a8c4ed00774c5c35e1487a33`
- chave privada (hex): `202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f`
- nonce (hex): `404142434445464748494a4b4c4d4e4f5051525354555657`
- `encryptedPrivateKey` (base64url, 73 bytes): `AUBBQkNERUZHSElKS0xNTk9QUVJTVFVWVyVmvEhw5hdU_i8_F5QXRdBzxrOQEYU4T5WNY0ytgSvemr3tpmGm9ofdjXdxwLdS-A`
