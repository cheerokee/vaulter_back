import { newId } from '../../shared/domain/id.js';
import { decodeMessage, encodeMessage } from './message-plaintext.js';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('message plaintext v1', () => {
  it('plain UTF-8 text (not the JSON) is the whole text', () => {
    expect(decodeMessage(bytes('liga a luz'))).toEqual({ text: 'liga a luz' });
    expect(decodeMessage(bytes('{"no":"text"}'))).toEqual({
      text: '{"no":"text"}',
    });
    expect(decodeMessage(bytes('[1,2]'))).toEqual({ text: '[1,2]' });
  });

  it('round trip with a proposal; unknown fields ignored; a bad proposal or decision is dropped', () => {
    const proposalId = newId();
    const content = {
      text: 'Posso gravar?',
      documentProposal: {
        proposalId,
        title: 'Ata',
        content: '# Ata',
        confidential: true,
      },
    };
    expect(decodeMessage(encodeMessage(content))).toEqual(content);
    expect(
      decodeMessage(
        bytes(
          JSON.stringify({
            text: 'sim',
            extra: 1,
            documentDecision: { proposalId, decision: 'record' },
            documentProposal: { proposalId: 'x', title: 't', content: 'c' },
          }),
        ),
      ),
    ).toEqual({
      text: 'sim',
      documentDecision: { proposalId, decision: 'record' },
    });
    expect(
      decodeMessage(
        bytes(
          JSON.stringify({
            text: 'talvez',
            documentDecision: { proposalId, decision: 'maybe' },
          }),
        ),
      ),
    ).toEqual({ text: 'talvez' });
  });
});
