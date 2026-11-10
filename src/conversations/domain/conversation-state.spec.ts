import { DomainValidationError } from '../../shared/domain/errors.js';
import { assertInitialState } from './conversation-state.js';

describe('assertInitialState', () => {
  it('a person creates in `na_fila` or `aviso`; the hub only in `aviso`', () => {
    expect(assertInitialState('user', 'na_fila')).toBe('na_fila');
    expect(assertInitialState('user', 'aviso')).toBe('aviso');
    expect(assertInitialState('hub', 'aviso')).toBe('aviso');
  });

  it('anything else is 422 conversation-state-invalid', () => {
    for (const [by, state] of [
      ['user', 'trabalhando'],
      ['user', 'arquivado'],
      ['hub', 'na_fila'],
      ['hub', 'concluido'],
      ['hub', 'dormindo'],
    ] as const) {
      expect(() => assertInitialState(by, state)).toThrow(
        expect.objectContaining({
          constructor: DomainValidationError,
          code: 'conversation-state-invalid',
        }) as Error,
      );
    }
  });
});
