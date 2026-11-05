import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { type ApiErrorBody, ERROR_CODES } from '@cims/shared';
import { AppError } from '../errors/app-error';
import type { CimsRequest } from '../http/request-context';

/**
 * Maps every thrown value to the uniform `{ error: { code, message } }` contract.
 * Internal failures are logged with the request id and returned as an opaque 500.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<CimsRequest>();
    const rawId: unknown = (req as { id?: unknown }).id;
    const requestId = rawId === undefined ? undefined : String(rawId);
    const { status, body } = this.toResponse(exception, requestId);

    if (status >= 500) {
      this.logger.error({ err: exception, requestId, path: req.path }, 'Unhandled error');
    }
    res.status(status).json(body);
  }

  private toResponse(
    exception: unknown,
    requestId?: string,
  ): { status: number; body: ApiErrorBody } {
    if (exception instanceof AppError) {
      return {
        status: exception.status,
        body: {
          error: {
            code: exception.code,
            message: exception.message,
            details: exception.details,
            requestId,
          },
        },
      };
    }
    if (exception instanceof ThrottlerException) {
      return {
        status: HttpStatus.TOO_MANY_REQUESTS,
        body: {
          error: {
            code: ERROR_CODES.RATE_LIMITED,
            message: 'Too many requests. Please try again later.',
            requestId,
          },
        },
      };
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        return {
          status: HttpStatus.CONFLICT,
          body: {
            error: {
              code: ERROR_CODES.CONFLICT,
              message: 'A record with the same unique value already exists',
              requestId,
            },
          },
        };
      }
      if (exception.code === 'P2025') {
        return {
          status: HttpStatus.NOT_FOUND,
          body: { error: { code: ERROR_CODES.NOT_FOUND, message: 'Record not found', requestId } },
        };
      }
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code =
        status === HttpStatus.NOT_FOUND
          ? ERROR_CODES.NOT_FOUND
          : status === HttpStatus.FORBIDDEN
            ? ERROR_CODES.FORBIDDEN
            : status === HttpStatus.UNAUTHORIZED
              ? ERROR_CODES.UNAUTHENTICATED
              : status < 500
                ? ERROR_CODES.VALIDATION_FAILED
                : ERROR_CODES.INTERNAL;
      const message = status < 500 ? exception.message : 'An unexpected error occurred';
      return { status, body: { error: { code, message, requestId } } };
    }
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        error: { code: ERROR_CODES.INTERNAL, message: 'An unexpected error occurred', requestId },
      },
    };
  }
}
