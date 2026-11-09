/**
 * Who an administrative operation is recorded as, in the organizations' `audit_logs`:
 * - `user`: a person acting on their own (the hub owner deregistering, ...): their id goes to `user_id`;
 * - `platform`: the platform team, through a support request. The staff account is NOT exposed to the customer
 *   (it lives in the platform trail): `user_id` stays null and the metadata carries the origin;
 * - `platform_staff`: the platform team acting on its own permission, with no support request (e.g. finance
 *   adjusting a storage quota). Same privacy as `platform`; `staffAction` names the operation (the platform trail has
 *   the who and why). It is NOT a support-request actor: operations that only a support request may run (appointing an
 *   admin, which opens the protection window) test for `platform` and never see this one.
 */
export type AuditActor =
  | { kind: 'user'; userId: string }
  | { kind: 'platform'; supportRequestId: string }
  | { kind: 'platform_staff'; staffAction: string };

/** The `userId` and the extra metadata to merge into every audit write of an operation run by `actor`. */
export function auditActorFields(actor: AuditActor): {
  userId: string | null;
  metadata: Record<string, unknown>;
} {
  switch (actor.kind) {
    case 'user':
      return { userId: actor.userId, metadata: {} };
    case 'platform':
      return {
        userId: null,
        metadata: {
          actor: 'platform',
          supportRequestId: actor.supportRequestId,
        },
      };
    case 'platform_staff':
      return {
        userId: null,
        metadata: { actor: 'platform', staffAction: actor.staffAction },
      };
  }
}
