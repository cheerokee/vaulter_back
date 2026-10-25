export interface InvalidField {
  field: string;
  messages: string[];
}

// Erro de formato de entrada (DTO), traduzido para 422 pelo filtro global.
export class RequestValidationError extends Error {
  constructor(readonly fields: InvalidField[]) {
    super('Request validation failed');
    this.name = 'RequestValidationError';
  }
}
