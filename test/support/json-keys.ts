/** Every object key at any depth of a JSON value. */
export const keysDeep = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap(keysDeep)
    : value !== null && typeof value === 'object'
      ? Object.entries(value).flatMap(([key, v]) => [key, ...keysDeep(v)])
      : [];
