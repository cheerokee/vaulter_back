import {
  ConflictError,
  DomainValidationError,
} from '../../shared/domain/errors.js';
import { Space } from './space.js';

const now = new Date('2026-10-25T00:00:00Z');
const make = () => Space.create({ organizationId: 'org', name: ' Casa ', now });

describe('Space', () => {
  it('is born at key version 1 with a trimmed name and no pending rotation', () => {
    const s = make();
    expect(s.name).toBe('Casa');
    expect(s.currentKeyVersion).toBe(1);
    expect(s.keyRotationRequired).toBe(false);
    expect(s.organizationId).toBe('org');
    expect(s.createdAt).toBe(now);
  });

  it.each(['', '   ', 'a'.repeat(256)])('rejects name %j', (name) => {
    expect(() => Space.create({ organizationId: 'o', name, now })).toThrow(
      DomainValidationError,
    );
    expect(() => make().rename(name)).toThrow(DomainValidationError);
  });

  it('renames with trim and accepts 255 chars', () => {
    const s = make();
    s.rename('  Novo ');
    expect(s.name).toBe('Novo');
    s.rename('a'.repeat(255));
    expect(s.name).toHaveLength(255);
  });

  it('restores props with the given id', () => {
    const s = Space.restore(
      {
        organizationId: 'o',
        name: 'x',
        currentKeyVersion: 3,
        keyRotationRequired: true,
      },
      'id-1',
    );
    expect(s.id).toBe('id-1');
    expect(s.currentKeyVersion).toBe(3);
  });

  it('completes rotation only to current + 1 and clears the flag', () => {
    const s = make();
    s.markRotationRequired();
    expect(s.keyRotationRequired).toBe(true);
    s.completeRotation(2);
    expect(s.currentKeyVersion).toBe(2);
    expect(s.keyRotationRequired).toBe(false);
  });

  it.each([1, 3, 0, -1])('rejects rotation to %i', (v) => {
    const s = make();
    s.markRotationRequired();
    expect(() => s.completeRotation(v)).toThrow(ConflictError);
    expect(s.currentKeyVersion).toBe(1);
    expect(s.keyRotationRequired).toBe(true);
  });

  it('rotation allowed while pending for anyone, otherwise only for a manager', () => {
    const s = make();
    expect(() => s.assertRotationAllowed(false)).toThrow(
      expect.objectContaining({ code: 'key-rotation-not-required' }),
    );
    expect(() => s.assertRotationAllowed(true)).not.toThrow();
    s.markRotationRequired();
    expect(() => s.assertRotationAllowed(false)).not.toThrow();
  });
});
