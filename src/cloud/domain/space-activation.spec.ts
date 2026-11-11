import { SpaceActivation, SpaceActivationRules } from './space-activation.js';

describe('SpaceActivation', () => {
  const authorized = () =>
    SpaceActivation.authorize({
      organizationId: 'o',
      spaceId: 's',
      termVersion: 1,
      byUserId: 'admin',
      at: new Date('2026-11-10T00:00:00Z'),
    });

  it('authorized -> active once; switching on again is 409 cloud-already-active', () => {
    const a = authorized();
    expect(a.state).toBe('authorized');
    const at = new Date('2026-11-10T01:00:00Z');
    a.activate('manager', at);
    expect(a).toMatchObject({
      state: 'active',
      activatedByUserId: 'manager',
      activatedAt: at,
    });
    expect(() => a.activate('manager', at)).toThrow(
      expect.objectContaining({ code: 'cloud-already-active' }),
    );
  });

  it('authorizing needs an online LLM allowed and someone in the space', () => {
    expect(() =>
      SpaceActivationRules.assertCanAuthorize({
        allowOnlineLlm: false,
        memberCount: 3,
      }),
    ).toThrow(expect.objectContaining({ code: 'online-llm-not-allowed' }));
    expect(() =>
      SpaceActivationRules.assertCanAuthorize({
        allowOnlineLlm: true,
        memberCount: 0,
      }),
    ).toThrow(expect.objectContaining({ code: 'space-orphaned' }));
    SpaceActivationRules.assertCanAuthorize({
      allowOnlineLlm: true,
      memberCount: 1,
    });
  });

  it('switching on without an authorization is 422 cloud-not-authorized', () => {
    expect(() => SpaceActivationRules.assertAuthorized(null)).toThrow(
      expect.objectContaining({ code: 'cloud-not-authorized' }),
    );
  });

  it('the server copies must cover every version exactly', () => {
    SpaceActivationRules.assertCoversVersions([2, 1], [1, 2]);
    expect(() =>
      SpaceActivationRules.assertCoversVersions([1, 1, 3], [1, 2]),
    ).toThrow(
      expect.objectContaining({
        code: 'key-versions-mismatch',
        details: {
          expectedVersions: [1, 2],
          missingVersions: [2],
          unexpectedVersions: [3],
          duplicatedVersions: [1],
        },
      }),
    );
  });
});
