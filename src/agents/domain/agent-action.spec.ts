import { ConflictError } from '../../shared/domain/errors.js';
import {
  type AgentActionItem,
  dedupeAgentActions,
  newAgentActions,
  sameAgentAction,
} from './agent-action.js';

const item = (over: Partial<AgentActionItem> = {}): AgentActionItem => ({
  id: '0192a000-0000-7000-8000-000000000001',
  conversationId: '0192a000-0000-7000-8000-0000000000c1',
  messageId: '0192a000-0000-7000-8000-0000000000d1',
  toolName: 'mcp:github/create_issue',
  effect: 'allow',
  decision: 'executed',
  startedAt: new Date('2026-11-21T10:00:00.000Z'),
  durationMs: 120,
  policyVersion: 3,
  ...over,
});

const conflict = (fn: () => unknown) => {
  try {
    fn();
    expect.unreachable();
  } catch (e) {
    expect(e).toBeInstanceOf(ConflictError);
    expect((e as ConflictError).code).toBe('agent-action-id-conflict');
  }
};

describe('sameAgentAction', () => {
  it('compares every field, the date by instant', () => {
    expect(
      sameAgentAction(
        item(),
        item({ startedAt: new Date('2026-11-21T10:00:00Z') }),
      ),
    ).toBe(true);
    for (const over of [
      { conversationId: '0192a000-0000-7000-8000-0000000000c2' },
      { messageId: '0192a000-0000-7000-8000-0000000000d2' },
      { toolName: 'browser:open' },
      { effect: 'confirm' as const },
      { decision: 'failed' as const },
      { startedAt: new Date('2026-11-21T10:00:00.001Z') },
      { durationMs: 121 },
      { policyVersion: 4 },
    ]) {
      expect(sameAgentAction(item(), item(over))).toBe(false);
    }
  });
});

describe('dedupeAgentActions', () => {
  it('the same id twice with the same content is one item, in order', () => {
    const b = item({ id: '0192a000-0000-7000-8000-000000000002' });
    expect(dedupeAgentActions([item(), b, item()])).toEqual([item(), b]);
  });

  it('the same id with another content is 409 agent-action-id-conflict', () => {
    conflict(() => dedupeAgentActions([item(), item({ durationMs: 1 })]));
  });
});

describe('newAgentActions', () => {
  it('keeps only what is not recorded yet; an equal recorded one is a no-op', () => {
    const recorded = item();
    const fresh = item({ id: '0192a000-0000-7000-8000-000000000002' });
    expect(
      newAgentActions([recorded, fresh], new Map([[recorded.id, recorded]])),
    ).toEqual([fresh]);
  });

  it('a recorded id with another content is 409 agent-action-id-conflict', () => {
    const recorded = item();
    conflict(() =>
      newAgentActions(
        [item({ decision: 'blocked' })],
        new Map([[recorded.id, recorded]]),
      ),
    );
  });
});
