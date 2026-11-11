import type { CloudFile } from './cloud-file.js';

/** One chunk to store (legible text + its embedding). */
export type NewChunk = {
  position: number;
  text: string;
  embedding: number[];
};

/**
 * The files of the active-cloud spaces (`cloud_files`, legible: name, path). Every method sets the RLS context of
 * `orgId`. Switching the cloud off DELETES the rows for real (with their chunks).
 */
export abstract class CloudFileRepository {
  abstract findById(orgId: string, id: string): Promise<CloudFile | null>;
  /** Every file of the space, without a lock (read in pages of ids). */
  abstract listForSpace(orgId: string, spaceId: string): Promise<CloudFile[]>;
  /**
   * The files of the space with these `fileId`s, `FOR UPDATE` in id order (one statement). REQUIRES a unit of work;
   * lock order: after the space row.
   */
  abstract lockByFileIds(
    orgId: string,
    spaceId: string,
    fileIds: readonly string[],
  ): Promise<CloudFile[]>;
  /** One file `FOR UPDATE` (null if gone). REQUIRES a unit of work; lock order: after the space row. */
  abstract lockById(orgId: string, id: string): Promise<CloudFile | null>;
  /** Inserts or updates by id. */
  abstract upsert(file: CloudFile): Promise<void>;
  /**
   * Inserts or updates many files of ONE space in one statement, by `(space_id, file_id)`; returns the row id of each
   * `fileId` (an existing row keeps its id).
   */
  abstract upsertMany(
    files: readonly CloudFile[],
  ): Promise<Map<string, string>>;
  /** Physical DELETE (the chunks go with them: FK ON DELETE CASCADE). */
  abstract deleteByIds(orgId: string, ids: readonly string[]): Promise<void>;
  /** Physical DELETE of every file of the space; returns how many. */
  abstract deleteForSpace(orgId: string, spaceId: string): Promise<number>;
}

/** The chunks (`cloud_chunks`, legible text + `vector(768)`), by file. Physical DELETE only. */
export abstract class CloudChunkRepository {
  /** Deletes the file's chunks and inserts these (positions 0..n-1), recording the embedding model in each one. */
  abstract replaceForFile(
    file: CloudFile,
    model: string,
    chunks: readonly NewChunk[],
  ): Promise<void>;
  abstract deleteForFile(orgId: string, cloudFileId: string): Promise<void>;
  /** The chunks of many files, in one statement. */
  abstract deleteForFiles(
    orgId: string,
    cloudFileIds: readonly string[],
  ): Promise<void>;
  /** Physical DELETE of every chunk of the space; returns how many. */
  abstract deleteForSpace(orgId: string, spaceId: string): Promise<number>;
}
