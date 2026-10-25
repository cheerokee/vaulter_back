# Material criptográfico do usuário (formato v1)

Contrato entre backend, app e hub. O backend **nunca vê a senha**: o cliente deriva uma chave mestra com
Argon2id e, dela, uma **prova de login** (enviada ao servidor) e uma **chave de cifra** (que nunca sai do
aparelho) que tranca a chave privada X25519 do usuário. Biblioteca: libsodium em todos os clientes.

## Codificação
Todo binário trafega em JSON como **base64url sem padding** (`URLSAFE_NO_PADDING`). Sem `=`, `+` ou `/`.

| Campo | Bytes | Caracteres |
|---|---|---|
| `kdfSalt` | 16 | 22 |
| `authProof` | 32 | 43 |
| `publicKey` | 32 | 43 |
| `encryptedPrivateKey` | 73 | 98 |

## Derivação
1. `kdfSalt`: 16 bytes aleatórios (`crypto_pwhash_SALTBYTES`), gerados no cadastro e a cada troca de senha.
2. `kdfParams`: exatamente `{ "algorithm": "argon2id13", "opsLimit": int, "memLimitBytes": int }`, sem outras
   chaves.
   - `opsLimit`: 2 a 10. `memLimitBytes`: 67108864 (64 MiB) a 1073741824 (1 GiB).
   - Padrão: `opsLimit` 3, `memLimitBytes` 67108864. É o que o pré-login devolve para e-mail inexistente.
3. Chave mestra: `crypto_pwhash(32, senha, kdfSalt, opsLimit, memLimitBytes, crypto_pwhash_ALG_ARGON2ID13)`.
   A senha entra em UTF-8.
4. Subchaves, com `crypto_kdf_derive_from_key(32, id, "acctkeys", chaveMestra)`:
   - `id = 1`: **`authProof`** (vai ao servidor, que a guarda como hash Argon2id);
   - `id = 2`: **chave de cifra** (nunca sai do aparelho).
5. O contexto `"acctkeys"` é fixo e não leva o nome do produto.

## Chaves e blob trancado
- `publicKey`: chave pública X25519 crua (`crypto_box_keypair`), 32 bytes.
- `encryptedPrivateKey` (73 bytes):

```
0x01 ‖ nonce (24) ‖ ciphertext+tag (48)
```

  `ciphertext+tag = crypto_aead_xchacha20poly1305_ietf_encrypt(privateKey (32), ad = 0x01, nonce, chaveDeCifra)`.
  O **primeiro byte é a versão do formato** (`0x01`) e também vai como dado associado (`ad`). Versão diferente
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
  próxima sincronização.
- **Troca de senha:** a **mesma chave privada** é trancada de novo com **novo salt** (e nova chave mestra). O
  cliente envia a prova atual e o novo material (`kdfSalt`, `kdfParams`, `authProof`, `encryptedPrivateKey`).
  A `publicKey` não muda, então as chaves de espaço trancadas para o usuário continuam abrindo. As demais
  sessões do usuário são revogadas.
- **Recuperação de senha por e-mail:** devolve o **login, não os dados**. A chave privada só abre com a senha
  (ou o kit de recuperação); quem perde os dois perde o que está cifrado.

## Sessões e refresh
O refresh token é rotativo: cada uso invalida o anterior, e reapresentar um token já usado conta como **reuso**
e revoga a sessão. Por isso o cliente **deve serializar as chamadas de refresh** (uma de cada vez, com fila ou
mutex) e reaproveitar o resultado para as requisições que esperam. Dois refreshes simultâneos com o mesmo token
derrubam a sessão.

## Implementação de referência
`test/support/client-crypto.ts` simula o lado do cliente com libsodium e segue este documento byte a byte.
