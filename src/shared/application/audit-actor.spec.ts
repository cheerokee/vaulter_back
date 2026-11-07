import { auditActorFields, type AuditActor } from './audit-actor.js';

describe('auditActorFields', () => {
  it('a user: the user id in the audit row, no extra metadata', () => {
    const actor: AuditActor = { kind: 'user', userId: 'u-1' };
    expect(auditActorFields(actor)).toEqual({ userId: 'u-1', metadata: {} });
  });

  it('the platform: no user id (the staff account stays in the platform trail), actor + support request in the metadata', () => {
    const actor: AuditActor = { kind: 'platform', supportRequestId: 'sr-1' };
    expect(auditActorFields(actor)).toEqual({
      userId: null,
      metadata: { actor: 'platform', supportRequestId: 'sr-1' },
    });
  });
});
