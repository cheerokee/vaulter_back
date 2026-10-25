import {
  ConflictError,
  DomainError,
  DomainValidationError,
  HubOfflineError,
  NotFoundError,
  PermissionDeniedError,
  UnauthenticatedError,
} from './errors.js';

describe('domain errors', () => {
  it.each([
    DomainValidationError,
    NotFoundError,
    PermissionDeniedError,
    ConflictError,
    HubOfflineError,
    UnauthenticatedError,
  ])('%o carries code, message, details and name', (Cls) => {
    const err = new Cls('some-code', 'some message', { a: 1 });
    expect(err).toBeInstanceOf(DomainError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('some-code');
    expect(err.message).toBe('some message');
    expect(err.details).toEqual({ a: 1 });
    expect(err.name).toBe(Cls.name);
  });
});
