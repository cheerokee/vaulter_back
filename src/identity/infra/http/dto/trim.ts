import { Transform } from 'class-transformer';

/** Strips surrounding whitespace from string input; other types reach the validators untouched. */
export const Trim = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );
