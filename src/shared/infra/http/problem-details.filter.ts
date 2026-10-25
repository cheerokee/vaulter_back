import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { QueryFailedError } from 'typeorm';
import {
  ConflictError,
  DomainError,
  DomainValidationError,
  HubOfflineError,
  NotFoundError,
  PermissionDeniedError,
  UnauthenticatedError,
} from '../../domain/errors.js';
import { newId } from '../../domain/id.js';
import {
  type InvalidField,
  RequestValidationError,
} from './request-validation.error.js';

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

const HTTP_CODES: Record<number, string> = {
  400: 'bad-request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not-found',
  405: 'method-not-allowed',
  406: 'not-acceptable',
  408: 'request-timeout',
  409: 'conflict',
  413: 'payload-too-large',
  415: 'unsupported-media-type',
  422: 'unprocessable-content',
  429: 'too-many-requests',
  503: 'service-unavailable',
};

interface Problem {
  status: number;
  code: string;
  detail: string;
  errors?: InvalidField[];
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  constructor(private readonly typeBaseUrl: string) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<{ id?: string | number }>();
    const res = http.getResponse<{
      status(code: number): any;
      setHeader(name: string, value: string): any;
      json(body: unknown): any;
    }>();
    const requestId = req?.id != null ? String(req.id) : newId();

    const problem = this.toProblem(exception, requestId);
    const body = {
      type: `${this.typeBaseUrl}/${problem.code}`,
      title: TITLES[problem.status] ?? 'Error',
      status: problem.status,
      detail: problem.detail,
      requestId,
      ...(problem.errors ? { errors: problem.errors } : {}),
    };
    res.status(problem.status);
    res.setHeader('Content-Type', 'application/problem+json');
    res.json(body);
  }

  private toProblem(exception: unknown, requestId: string): Problem {
    if (exception instanceof RequestValidationError) {
      return {
        status: 422,
        code: 'validation-failed',
        detail: 'One or more fields are invalid',
        errors: exception.fields,
      };
    }
    if (exception instanceof DomainError) {
      return {
        status: this.domainStatus(exception),
        code: exception.code,
        detail: exception.message,
      };
    }
    if (
      exception instanceof QueryFailedError &&
      (exception.driverError as { code?: string } | undefined)?.code === '23505'
    ) {
      return {
        status: 409,
        code: 'conflict',
        detail: 'The resource conflicts with an existing one',
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status < 500) {
        return {
          status,
          code: HTTP_CODES[status] ?? `http-${status}`,
          detail: exception.message,
        };
      }
    }
    this.logger.error(
      `Unhandled error (requestId=${requestId})`,
      exception instanceof Error ? exception.stack : String(exception),
    );
    Sentry.captureException(exception);
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'internal-error',
      detail: 'An unexpected error occurred',
    };
  }

  private domainStatus(e: DomainError): number {
    if (e instanceof DomainValidationError) return 422;
    if (e instanceof NotFoundError) return 404;
    if (e instanceof PermissionDeniedError) return 403;
    if (e instanceof ConflictError) return 409;
    if (e instanceof UnauthenticatedError) return 401;
    if (e instanceof HubOfflineError) return 503;
    return 500;
  }
}
