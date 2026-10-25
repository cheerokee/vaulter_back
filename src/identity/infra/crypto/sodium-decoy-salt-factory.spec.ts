import type { ConfigService } from '@nestjs/config';
import { assertKdfSalt } from '../../domain/crypto-material.js';
import { SodiumDecoySaltFactory } from './sodium-decoy-salt-factory.js';

const config = (key: string) =>
  ({ getOrThrow: () => key }) as unknown as ConfigService;
const KEY_A = 'A'.repeat(42) + 'A';
const KEY_B = 'B'.repeat(42) + 'A';

describe('SodiumDecoySaltFactory', () => {
  it('is deterministic per e-mail and a valid kdf salt', async () => {
    const f = new SodiumDecoySaltFactory(config(KEY_A));
    const s = await f.saltFor('ana@x.com');
    expect(await f.saltFor('ana@x.com')).toBe(s);
    expect(() => assertKdfSalt(s)).not.toThrow();
    expect(s).toHaveLength(22);
  });

  it('differs between e-mails and between keys', async () => {
    const f = new SodiumDecoySaltFactory(config(KEY_A));
    const g = new SodiumDecoySaltFactory(config(KEY_B));
    expect(await f.saltFor('ana@x.com')).not.toBe(await f.saltFor('bob@x.com'));
    expect(await f.saltFor('ana@x.com')).not.toBe(await g.saltFor('ana@x.com'));
  });
});
