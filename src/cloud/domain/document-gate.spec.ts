import { newId } from '../../shared/domain/id.js';
import { confirmedProposal, type HistoryMessage } from './document-gate.js';

const proposalId = newId();
const proposal = {
  proposalId,
  title: 'Salários',
  content: '# Tabela',
  confidential: true,
};
const cloud = (withProposal = true): HistoryMessage => ({
  id: newId(),
  author: 'cloud',
  authorUserId: null,
  content: withProposal
    ? { text: 'Posso gravar?', documentProposal: proposal }
    : { text: 'oi' },
});
const person = (
  text: string,
  decision?: 'record' | 'decline',
): HistoryMessage => ({
  id: newId(),
  author: 'person',
  authorUserId: 'u1',
  content: {
    text,
    ...(decision ? { documentDecision: { proposalId, decision } } : {}),
  },
});

describe('confirmedProposal (record only after the person confirmed)', () => {
  it('the proposal right before the answered message: confirmed', () => {
    const yes = person('sim, pode gravar');
    expect(confirmedProposal([cloud(), yes], yes.id, proposalId)).toEqual({
      proposal,
    });
    const button = person('', 'record');
    expect(confirmedProposal([cloud(), button], button.id, proposalId)).toEqual(
      { proposal },
    );
  });

  it('no proposal right before (first ask, another message in between, other id): refused', () => {
    const ask = person('grava isso: salários');
    expect(confirmedProposal([ask], ask.id, proposalId)).toEqual({
      refused: 'no-proposal',
    });
    const later = person('e mais isto');
    expect(
      confirmedProposal([cloud(), person('hm'), later], later.id, proposalId),
    ).toEqual({ refused: 'no-proposal' });
    const yes = person('sim');
    expect(confirmedProposal([cloud(false), yes], yes.id, proposalId)).toEqual({
      refused: 'no-proposal',
    });
    expect(confirmedProposal([cloud(), yes], yes.id, newId())).toEqual({
      refused: 'no-proposal',
    });
  });

  it('the decline button wins over the model', () => {
    const no = person('', 'decline');
    expect(confirmedProposal([cloud(), no], no.id, proposalId)).toEqual({
      refused: 'declined',
    });
  });
});
