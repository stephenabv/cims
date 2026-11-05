import { HttpStatus } from '@nestjs/common';
import { ERROR_CODES, type ErrorCode } from '@cims/shared';

/**
 * Base class for expected, client-facing failures. Anything that is not an AppError (or a Nest
 * HttpException) is treated as an internal error and its details are never sent to the client.
 */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: HttpStatus,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(details: unknown, message = 'The request contains invalid data') {
    super(ERROR_CODES.VALIDATION_FAILED, message, HttpStatus.BAD_REQUEST, details);
  }
}

export class UnauthenticatedError extends AppError {
  constructor(code: ErrorCode = ERROR_CODES.UNAUTHENTICATED, message = 'Authentication required') {
    super(code, message, HttpStatus.UNAUTHORIZED);
  }
}

export class ForbiddenError extends AppError {
  constructor(
    message = 'You do not have permission to perform this action',
    code: ErrorCode = ERROR_CODES.FORBIDDEN,
  ) {
    super(code, message, HttpStatus.FORBIDDEN);
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string) {
    super(ERROR_CODES.NOT_FOUND, `${entity} not found`, HttpStatus.NOT_FOUND);
  }
}

/** Business-rule or state conflict (invalid transition, duplicate, stale version). */
export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(ERROR_CODES.CONFLICT, message, HttpStatus.CONFLICT, details);
  }
}

export class LockedError extends AppError {
  constructor(
    message: string,
    readonly lockedUntil: Date,
  ) {
    super(ERROR_CODES.ACCOUNT_LOCKED, message, HttpStatus.LOCKED, {
      lockedUntil: lockedUntil.toISOString(),
    });
  }
}
