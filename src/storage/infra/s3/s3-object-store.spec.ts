import type { ConfigService } from '@nestjs/config';
import { DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { DELETE_OBJECTS_MAX_KEYS, S3ObjectStore } from './s3-object-store.js';

const config = {
  getOrThrow: (k: string) =>
    ({ S3_BUCKET_HUB_BRAIN: 'bucket', AWS_REGION: 'us-east-1' })[k],
  get: () => undefined,
} as unknown as ConfigService;

function storeWith(send: (cmd: unknown) => Promise<unknown>) {
  const store = new S3ObjectStore(config);
  const client = (store as unknown as { client: { send: unknown } }).client;
  const spy = vi.fn(send);
  client.send = spy;
  return { store, spy };
}

const refs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ key: `k/${i}`, versionId: `v${i}` }));

describe('S3ObjectStore.deleteVersions', () => {
  it('sends one quiet DeleteObjects per 1000 versions', async () => {
    expect(DELETE_OBJECTS_MAX_KEYS).toBe(1000);
    const { store, spy } = storeWith(async () => ({}));
    expect(await store.deleteVersions(refs(2001))).toEqual({ failed: [] });
    expect(spy).toHaveBeenCalledTimes(3);
    const sizes = spy.mock.calls.map(([cmd]) => {
      expect(cmd).toBeInstanceOf(DeleteObjectsCommand);
      const input = (cmd as DeleteObjectsCommand).input;
      expect(input.Bucket).toBe('bucket');
      expect(input.Delete!.Quiet).toBe(true);
      return input.Delete!.Objects!.length;
    });
    expect(sizes).toEqual([1000, 1000, 1]);
    const first = (spy.mock.calls[0]![0] as DeleteObjectsCommand).input;
    expect(first.Delete!.Objects![0]).toEqual({ Key: 'k/0', VersionId: 'v0' });
  });

  it('never sends an empty request', async () => {
    const { store, spy } = storeWith(async () => ({}));
    expect(await store.deleteVersions([])).toEqual({ failed: [] });
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns the per-key errors and every version of a batch whose call failed, without throwing', async () => {
    let call = 0;
    const { store } = storeWith(async () => {
      call++;
      if (call === 1) {
        return {
          Errors: [
            { Key: 'k/3', VersionId: 'v3', Code: 'AccessDenied' },
            // Already gone: counts as deleted.
            { Key: 'k/4', VersionId: 'v4', Code: 'NoSuchVersion' },
          ],
        };
      }
      throw new Error('network down');
    });
    const out = await store.deleteVersions(refs(1002));
    expect(out.failed).toEqual([
      { key: 'k/3', versionId: 'v3' },
      { key: 'k/1000', versionId: 'v1000' },
      { key: 'k/1001', versionId: 'v1001' },
    ]);
  });
});
