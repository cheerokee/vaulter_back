/**
 * Who an administrative operation is recorded as, in the organizations' `audit_logs`:
 * - `user`: a person acting on their own (the hub owner deregistering, ...): their id goes to `user_id`;
 * - `platform`: the platform team, through a support request. The staff account is NOT exposed to the customer
 *   (it lives in the platform trail): `user_id` stays null and the metadata carries the origin.
 */
export type AuditActor =
  | { kind: 'user'; userId: string }
  | { kind: 'platform'; supportRequestId: string };

/** The `userId` and the extra metadata to merge into every audit write of an operation run by `actor`. */
export function auditActorFields(actor: AuditActor): {
  userId: string | null;
  metadata: Record<string, unknown>;
} {
  return actor.kind === 'user'
    ? { userId: actor.userId, metadata: {} }
    : {
        userId: null,
        metadata: {
          actor: 'platform',
          supportRequestId: actor.supportRequestId,
        },
      };
}
