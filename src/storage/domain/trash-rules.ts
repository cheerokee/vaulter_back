import { MAX_TRASH_VERSIONS_PER_OBJECT } from './backup-limits.js';

/** A superseded (trash) version of one object. */
export type SupersededVersion = { id: string; supersededAt: Date };

/** What the purge needs of a locked object. */
export type PurgeGuard = { id: string; liveVersionId: string | null };

// Regras da lixeira (spec storage-backup §4.8, "Controle da lixeira"): o limite de versões antigas por objeto e a
// trava de segurança do esvaziar (a versão viva de um objeto vivo nunca é apagada).
export const TrashRules = {
  /**
   * The superseded versions beyond the `cap` most recent (by `supersededAt`, ties broken by id: the newer UUID v7
   * stays). Returns the ids to purge, in no particular order.
   */
  beyondCap(
    superseded: readonly SupersededVersion[],
    cap: number = MAX_TRASH_VERSIONS_PER_OBJECT,
  ): string[] {
    if (superseded.length <= cap) return [];
    const newestFirst = [...superseded].sort(
      (a, b) =>
        b.supersededAt.getTime() - a.supersededAt.getTime() ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
    return newestFirst.slice(cap).map((v) => v.id);
  },

  /**
   * Second lock on top of the SQL: drops from the candidates every live version of the (locked) objects. The current
   * committed version of a live object is never purged.
   */
  purgeable(
    candidateIds: readonly string[],
    objects: readonly PurgeGuard[],
  ): string[] {
    const live = new Set(
      objects
        .map((o) => o.liveVersionId)
        .filter((id): id is string => id !== null),
    );
    return candidateIds.filter((id) => !live.has(id));
  },
};
