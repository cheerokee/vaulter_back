import { isUuidV7, newId } from '../../shared/domain/id.js';
import {
  answerIdFor,
  budgetNoticeIdFor,
  CLOUD_FALLBACK_AFTER_MS,
  derivedV7,
  documentObjectIdFor,
  nextResponderStep,
  type PlannedMessage,
} from './responder.js';

const T0 = new Date('2026-11-11T12:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const person = (
  sentAtMs: number,
  extra: Partial<PlannedMessage> = {},
): PlannedMessage => ({
  id: newId(),
  authorUserId: 'u1',
  pending: true,
  ackedByCloud: false,
  cloudAnswerRequested: false,
  sentAt: at(sentAtMs),
  ...extra,
});
const plan = (
  messages: PlannedMessage[],
  nowMs: number,
  opts: { cloudAnswer?: boolean; hub?: boolean } = {},
) =>
  nextResponderStep({
    messages,
    conversationCloudAnswer: opts.cloudAnswer ?? false,
    hasExecutorHub: opts.hub ?? true,
    now: at(nowMs),
  });

describe('responder rules', () => {
  it('CLOUD_FALLBACK_AFTER_MS is 30 s (plan, Global Constraints)', () => {
    expect(CLOUD_FALLBACK_AFTER_MS).toBe(30_000);
  });

  it('derived ids are UUID v7, deterministic, distinct per label and keep the timestamp', () => {
    const base = newId();
    const a = answerIdFor(base);
    expect(isUuidV7(a)).toBe(true);
    expect(answerIdFor(base)).toBe(a);
    expect(budgetNoticeIdFor(base)).not.toBe(a);
    expect(documentObjectIdFor(base)).not.toBe(a);
    expect(a.slice(0, 13)).toBe(base.slice(0, 13));
    expect(derivedV7(newId(), 'x')).not.toBe(derivedV7(newId(), 'x'));
  });

  it('a pending message is the Hub’s for 30 s, then the cloud’s', () => {
    const m = person(0);
    expect(plan([m], 29_999)).toEqual({ kind: 'wait', at: at(30_000) });
    expect(plan([m], 30_000)).toEqual({
      kind: 'answer',
      message: m,
      resume: false,
    });
  });

  it('"responder pela nuvem" (conversation, message, or a later message) and no executor Hub: at once', () => {
    const first = person(0);
    expect(plan([first], 1, { cloudAnswer: true }).kind).toBe('answer');
    expect(plan([first], 1, { hub: false }).kind).toBe('answer');
    expect(plan([person(0, { cloudAnswerRequested: true })], 1).kind).toBe(
      'answer',
    );
    // In order: a later message asking for the cloud takes the earlier pending one first.
    const later = person(5, { cloudAnswerRequested: true });
    expect(plan([first, later], 6)).toEqual({
      kind: 'answer',
      message: first,
      resume: false,
    });
  });

  it('in order: the cloud finishes the message it acknowledged before taking the next', () => {
    const mine = person(0, { pending: false, ackedByCloud: true });
    const next = person(1);
    expect(plan([mine, next], 60_000)).toEqual({
      kind: 'answer',
      message: mine,
      resume: true,
    });
    // Once answered (the answer's derived id is in the history), the next one.
    const answer = {
      ...person(2, { pending: false }),
      id: answerIdFor(mine.id),
      authorUserId: null,
    };
    expect(plan([mine, next, answer], 60_000)).toEqual({
      kind: 'answer',
      message: next,
      resume: false,
    });
  });

  it('a message the Hub took is never the cloud’s; nothing pending = idle', () => {
    const hubs = person(0, { pending: false, ackedByCloud: false });
    expect(plan([hubs], 60_000)).toEqual({ kind: 'idle' });
    expect(plan([], 0)).toEqual({ kind: 'idle' });
  });
});
