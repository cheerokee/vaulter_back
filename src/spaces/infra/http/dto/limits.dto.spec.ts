import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SPACE_MAX_MEMBERS } from '../../../domain/space-membership.js';
import {
  RecoverOrphanSpaceDto,
  RewrapRecoveryDto,
  RotateSpaceKeyDto,
} from './key.dto.js';
import { AddSpaceMemberDto } from './member.dto.js';
import { MAX_KEY_VERSIONS } from './formats.js';

const WK = Buffer.alloc(81, 1).toString('base64url');
const PK = Buffer.alloc(32, 7).toString('base64url');
const USER = '019a1b2c-0000-7000-8000-0000000000d1';
const versions = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ version: i + 1, wrappedKey: WK }));
const errorsOf = async <T extends object>(
  cls: new () => T,
  body: object,
): Promise<string[]> =>
  (await validate(plainToInstance(cls, body))).map((e) => e.property);

describe('spaces DTO limits', () => {
  it('accepts up to MAX_KEY_VERSIONS (500) versions when adding, rewrapping and recovering', async () => {
    expect(MAX_KEY_VERSIONS).toBe(500);
    for (const [n, ok] of [
      [MAX_KEY_VERSIONS, true],
      [MAX_KEY_VERSIONS + 1, false],
    ] as const) {
      expect(
        await errorsOf(AddSpaceMemberDto, {
          userId: USER,
          roleKey: 'space_reader',
          grants: versions(n),
        }),
      ).toEqual(ok ? [] : ['grants']);
      expect(
        await errorsOf(RewrapRecoveryDto, {
          recoveryPublicKey: PK,
          versions: versions(n),
        }),
      ).toEqual(ok ? [] : ['versions']);
      expect(
        await errorsOf(RecoverOrphanSpaceDto, {
          grants: versions(n),
          currentAuthProof: 'proof',
        }),
      ).toEqual(ok ? [] : ['grants']);
    }
  });

  it('a rotation takes one copy per member up to SPACE_MAX_MEMBERS and never caps the version', async () => {
    const body = (members: number, version: number) => ({
      version,
      recoveryPublicKey: PK,
      recoveryWrappedKey: WK,
      grants: Array.from({ length: members }, () => ({
        userId: USER,
        wrappedKey: WK,
      })),
    });
    expect(
      await errorsOf(RotateSpaceKeyDto, body(SPACE_MAX_MEMBERS, 2)),
    ).toEqual([]);
    expect(
      await errorsOf(RotateSpaceKeyDto, body(SPACE_MAX_MEMBERS + 1, 2)),
    ).toEqual(['grants']);
    expect(await errorsOf(RotateSpaceKeyDto, body(1, 1_000_000))).toEqual([]);
  });

  it('the largest bodies stay under the 100 kB default JSON limit', () => {
    const limit = 100 * 1024;
    const add = JSON.stringify({
      userId: USER,
      roleKey: 'space_manager',
      grants: Array.from({ length: MAX_KEY_VERSIONS }, (_, i) => ({
        version: 100_000 + i,
        wrappedKey: WK,
      })),
    });
    const rotate = JSON.stringify({
      version: 100_000,
      recoveryPublicKey: PK,
      recoveryWrappedKey: WK,
      grants: Array.from({ length: SPACE_MAX_MEMBERS }, () => ({
        userId: USER,
        wrappedKey: WK,
      })),
    });
    expect(add.length).toBeLessThan(limit);
    expect(rotate.length).toBeLessThan(limit);
  });
});
