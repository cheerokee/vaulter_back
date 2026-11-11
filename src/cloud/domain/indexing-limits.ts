// Limites da indexação da nuvem ativa (spec active-cloud §4.2; contrato do manifesto em docs/hubs/space-manifest.md).
// Mudar um valor que o Hub precisa respeitar (manifesto, partes) é mudança de contrato: atualize o documento junto.

const MiB = 1024 * 1024;

/** Overhead of a backup blob (`0x01 ‖ nonce(24) ‖ ciphertext + tag(16)`, docs/crypto/space-backup.md). */
export const BACKUP_BLOB_OVERHEAD_BYTES = 41;

/** A manifest blob bigger than this is not read (the manifest is skipped; the index stays as it was). */
export const MANIFEST_MAX_BYTES = 64 * MiB;
/** Files per manifest. */
export const MANIFEST_MAX_FILES = 100_000;
/** Parts per file (each part one backup object, up to 5 GiB). */
export const FILE_MAX_PARTS = 1000;
export const FILE_NAME_MAX_CHARS = 255;
export const FILE_PATH_MAX_CHARS = 1024;
export const MEDIA_TYPE_MAX_CHARS = 255;
export const CONNECTOR_MAX_CHARS = 100;

/** A file whose parts sum more than this (decrypted) is not indexed (`too-large`): it stays in the backup only. */
export const INDEXED_FILE_MAX_BYTES = 100 * MiB;
/** Text kept per file after extraction; the rest is dropped (the file is indexed truncated). */
export const EXTRACTED_TEXT_MAX_CHARS = 5_000_000;

/** docx/xlsx are zip files: guards against zip bombs, checked BEFORE inflating anything. */
export const ZIP_MAX_ENTRIES = 10_000;
/** Uncompressed size of one zip entry we read (document.xml, a sheet, sharedStrings). */
export const ZIP_ENTRY_MAX_BYTES = 64 * MiB;
/** Uncompressed size of every entry we read from one file, together. */
export const ZIP_TOTAL_MAX_BYTES = 128 * MiB;
/** Uncompressed / compressed above this is refused as a bomb (normal office XML compresses ~10-20x). */
export const ZIP_MAX_RATIO = 200;

/** Chunking: the Hub's (vaulter-hub-back/index_docs.py): paragraphs packed up to 800 chars, no overlap. */
export const CHUNK_MAX_CHARS = 800;
/** Shorter chunks are dropped (as the Hub does), except when it is the file's only text. */
export const CHUNK_MIN_CHARS = 80;

/** Texts per embedding call (one budget check per batch: Task 5). */
export const EMBEDDING_BATCH = 32;

/** A change in the backup reindexes the space this many seconds later (debounce: a Hub uploads in bursts). */
export const INDEX_SPACE_DEBOUNCE_SECONDS = 2;
