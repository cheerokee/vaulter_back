import sodium from 'libsodium-wrappers-sumo';

/** Returns the libsodium instance, awaiting its WASM initialisation. */
export async function getSodium(): Promise<typeof sodium> {
  await sodium.ready;
  return sodium;
}
