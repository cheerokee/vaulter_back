import { Type } from 'class-transformer';
import type { CursorPage } from '../../domain/pagination.js';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Query string of cursor-paginated listings. */
export class CursorPaginationQuery {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

/** Response body of a cursor-paginated listing: `{ items, nextCursor }`. */
export function pageResponse<T, R>(
  page: CursorPage<T>,
  map: (item: T) => R,
): { items: R[]; nextCursor: string | null } {
  return { items: page.items.map(map), nextCursor: page.nextCursor };
}
