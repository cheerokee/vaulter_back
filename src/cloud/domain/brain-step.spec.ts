import {
  assertToolResultSizes,
  BRAIN_BODY_MAX_BYTES,
  BRAIN_MAX_CALLS,
  BRAIN_TOOL_RESULT_MAX_BYTES,
  brainStepLimit,
  cloudNotActive,
  cloudTermsAgentNotAccepted,
  isBrainContentBlock,
  type BrainTurn,
} from './brain-step.js';

const resultTurn = (...contents: string[]): BrainTurn => ({
  role: 'user',
  content: contents.map((content, i) => ({
    type: 'tool_result',
    toolUseId: `t${i}`,
    content,
  })),
});

describe('brain step (domain)', () => {
  it('has the spec constants', () => {
    expect(BRAIN_MAX_CALLS).toBe(16);
    expect(BRAIN_TOOL_RESULT_MAX_BYTES).toBe(32 * 1024);
    expect(BRAIN_BODY_MAX_BYTES).toBe(256 * 1024);
  });

  describe('isBrainContentBlock', () => {
    it.each([
      [{ type: 'text', text: 'oi' }],
      [
        {
          type: 'tool_use',
          id: 't1',
          name: 'folder:read',
          input: { path: 'a' },
        },
      ],
      [{ type: 'tool_result', toolUseId: 't1', content: 'ok' }],
      [{ type: 'tool_result', toolUseId: 't1', content: 'x', isError: true }],
    ])('accepts %j', (block) => {
      expect(isBrainContentBlock(block)).toBe(true);
    });

    it.each([
      [null],
      ['text'],
      [{ type: 'image', url: 'x' }],
      [{ type: 'text' }],
      [{ type: 'text', text: 'oi', extra: 1 }],
      [{ type: 'tool_use', id: 't1', name: 'x', input: [] }],
      [{ type: 'tool_use', id: 't1', name: 'x', input: null }],
      [{ type: 'tool_use', id: '', name: 'x', input: {} }],
      [{ type: 'tool_use', id: 't1', name: 'x'.repeat(201), input: {} }],
      [{ type: 'tool_result', toolUseId: 't1', content: 3 }],
      [{ type: 'tool_result', toolUseId: 't1', content: 'x', isError: 'no' }],
    ])('refuses %j', (block) => {
      expect(isBrainContentBlock(block)).toBe(false);
    });
  });

  describe('assertToolResultSizes', () => {
    it('accepts results up to 32 KiB of UTF-8', () => {
      expect(() =>
        assertToolResultSizes([
          resultTurn('é'.repeat(BRAIN_TOOL_RESULT_MAX_BYTES / 2), 'a'),
        ]),
      ).not.toThrow();
    });

    it('refuses a result over 32 KiB in UTF-8 bytes (not characters), naming only its position', () => {
      const text = 'é'.repeat(BRAIN_TOOL_RESULT_MAX_BYTES / 2) + 'a';
      expect(text.length).toBeLessThan(BRAIN_TOOL_RESULT_MAX_BYTES);
      let caught: unknown;
      try {
        assertToolResultSizes([
          { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
          resultTurn('ok', text),
        ]);
      } catch (e) {
        caught = e;
      }
      expect(caught).toMatchObject({
        code: 'validation-failed',
        details: { turn: 1, block: 1, maxBytes: BRAIN_TOOL_RESULT_MAX_BYTES },
      });
      // Never the content.
      expect(JSON.stringify(caught)).not.toContain('éé');
      expect((caught as Error).message).not.toContain('éé');
    });
  });

  it('has the stable error types', () => {
    expect(cloudNotActive()).toMatchObject({ code: 'cloud-not-active' });
    expect(cloudTermsAgentNotAccepted()).toMatchObject({
      code: 'cloud-terms-agent-not-accepted',
    });
    expect(brainStepLimit()).toMatchObject({
      code: 'brain-step-limit',
      details: { maxCalls: BRAIN_MAX_CALLS },
    });
  });
});
