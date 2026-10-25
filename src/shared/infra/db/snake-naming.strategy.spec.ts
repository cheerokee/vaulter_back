import { SnakeNamingStrategy } from './snake-naming.strategy.js';

describe('SnakeNamingStrategy', () => {
  const strategy = new SnakeNamingStrategy();

  it('converts camelCase properties to snake_case columns', () => {
    expect(strategy.columnName('refreshTokenHash', undefined, [])).toBe(
      'refresh_token_hash',
    );
  });

  it('prefers an explicit column name', () => {
    expect(strategy.columnName('refreshTokenHash', 'custom', [])).toBe(
      'custom',
    );
  });
});
