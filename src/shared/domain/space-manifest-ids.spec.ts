import {
  cloudManifestObjectId,
  hubManifestObjectId,
} from './space-manifest-ids.js';

// Test vector of docs/hubs/space-manifest.md (also checked with Python's uuid.uuid5).
describe('space manifest object ids', () => {
  const spaceId = '0195f3a2-7c4e-7b1d-9a3f-2c8e5d4b6a10';

  it('derives the documented ids (UUID v5, namespace = spaceId)', () => {
    expect(hubManifestObjectId(spaceId)).toBe(
      '8b2a7308-2fac-524e-b218-e264728c6c38',
    );
    expect(cloudManifestObjectId(spaceId)).toBe(
      '6a07a309-1c68-5a34-b67f-6b0c8749a005',
    );
  });

  it('differs per space', () => {
    const other = '0195f3a2-7c4e-7b1d-9a3f-2c8e5d4b6a11';
    expect(hubManifestObjectId(other)).not.toBe(hubManifestObjectId(spaceId));
  });
});
