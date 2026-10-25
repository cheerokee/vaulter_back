import { ParseUUIDPipe } from '@nestjs/common';
import { RequestValidationError } from './request-validation.error.js';

export const uuidPipe = (field: string) =>
  new ParseUUIDPipe({
    exceptionFactory: () =>
      new RequestValidationError([
        { field, messages: [`${field} must be a UUID`] },
      ]),
  });
