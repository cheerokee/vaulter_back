import type { AgentTurnView } from '../../../conversations/application/agent-turn.js';

/**
 * The document proposals the brain step issued (spec pc-agent §5.3, "Ferramentas de documento"; table
 * `agent_issued_proposals`, only ids and the SHA-256 of the canonical content, `proposalContentSha256`). A proposal in
 * an executor hub's message counts for recording only when it is one of these, for the same conversation, with the
 * same hash: the agent cannot attach a made-up or altered proposal to its own answer. Each call is a short transaction
 * of its own in the organization's scope (never inside a unit of work).
 */
export abstract class AgentIssuedProposals {
  /** Records a proposal `propose_document` just issued in `view`'s conversation (idempotent per proposal id). */
  abstract record(
    view: AgentTurnView,
    proposalId: string,
    contentSha256: string,
  ): Promise<void>;
  /** The content hashes of the given proposal ids issued for `view`'s conversation (unknown ids are absent). */
  abstract hashesOf(
    view: AgentTurnView,
    proposalIds: readonly string[],
  ): Promise<Map<string, string>>;
}
