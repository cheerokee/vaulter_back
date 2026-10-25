import { newId } from '../../../shared/domain/id.js';
import { SodiumRefreshTokenCodec } from './sodium-refresh-token-codec.js';

describe('SodiumRefreshTokenCodec', () => {
  const codec = new SodiumRefreshTokenCodec();

  it('round-trips generate and parse with the same hash', async () => {
    const id = newId();
    const { token, hash } = await codec.generate(id);
    expect(token.startsWith(`${id}.`)).toBe(true);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(codec.parse(token)).toEqual({ sessionId: id, hash });
  });

  it('generates distinct tokens', async () => {
    const id = newId();
    const a = await codec.generate(id);
    const b = await codec.generate(id);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).not.toBe(b.hash);
  });

  it('returns null for malformed tokens', async () => {
    const id = newId();
    const { token } = await codec.generate(id);
    const secret = token.split('.')[1];
    expect(codec.parse('x')).toBeNull();
    expect(codec.parse('notuuid.abc')).toBeNull();
    expect(codec.parse(`${id}.`)).toBeNull();
    expect(codec.parse(`${id}.abc`)).toBeNull();
    expect(codec.parse(`${id}.${secret}=`)).toBeNull();
    expect(codec.parse(`${id}.${secret}.extra`)).toBeNull();
    expect(codec.parse(`notuuid.${secret}`)).toBeNull();
    expect(codec.parse('')).toBeNull();
  });
});
