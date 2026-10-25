// Erros de domínio: sem conhecimento de HTTP. O filtro global da borda traduz para status.
export abstract class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class DomainValidationError extends DomainError {}
export class NotFoundError extends DomainError {}
export class PermissionDeniedError extends DomainError {}
export class ConflictError extends DomainError {}
export class HubOfflineError extends DomainError {}
export class UnauthenticatedError extends DomainError {}
