import {
  assertIdsOnlyPayload,
  assertQueueName,
  assertSendOptions,
} from './job-queue.js';

const uuid = '0192f5a0-1b2c-7d3e-8f40-123456789abc';

describe('job queue port checks', () => {
  it('accepts queue names of lowercase words joined by . or -', () => {
    expect(assertQueueName('cloud.index-object')).toBe('cloud.index-object');
    for (const bad of ['', 'Cloud', 'cloud..x', '-x', 'x_y', 'x ']) {
      expect(() => assertQueueName(bad)).toThrow(/queue name/);
    }
  });

  it('accepts payloads of UUIDs and safe integers only', () => {
    expect(assertIdsOnlyPayload({ spaceId: uuid, keyVersion: 2 })).toEqual({
      spaceId: uuid,
      keyVersion: 2,
    });
    expect(assertIdsOnlyPayload({})).toEqual({});
  });

  it.each([
    [{ note: 'hello' }],
    [{ spaceId: uuid.toUpperCase() }],
    [{ n: 1.5 }],
    [{ n: Number.MAX_SAFE_INTEGER + 1 }],
    [{ flag: true }],
    [{ nested: { spaceId: uuid } }],
    [{ 'bad-key': uuid }],
    [[uuid]],
    [null],
    ['x'],
  ])('rejects %j without echoing the value', (payload) => {
    let message = '';
    try {
      assertIdsOnlyPayload(payload);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('hello');
  });

  it('checks the send options', () => {
    expect(
      assertSendOptions({ startAfterSeconds: 30, singletonKey: `m:${uuid}` }),
    ).toBeTruthy();
    expect(() => assertSendOptions({ startAfterSeconds: -1 })).toThrow();
    expect(() => assertSendOptions({ startAfterSeconds: 1.5 })).toThrow();
    expect(() => assertSendOptions({ singletonKey: '' })).toThrow();
    expect(() => assertSendOptions({ singletonKey: 'a b' })).toThrow();
  });
});
