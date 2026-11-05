import type { ApiErrorBody } from '@cims/shared';
import { readCookie } from './cookies';

const BASE = '/api/v1';
const CSRF_COOKIE = 'cims_csrf';
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field-level messages from a VALIDATION_FAILED response, keyed by dotted path. */
  fieldErrors(): Record<string, string> {
    if (!Array.isArray(this.details)) return {};
    const out: Record<string, string> = {};
    for (const d of this.details as Array<{ path?: string; message?: string }>) {
      if (d.path && d.message && !out[d.path]) out[d.path] = d.message;
    }
    return out;
  }
}

export class NetworkError extends Error {
  constructor() {
    super('Unable to reach the server. Check your connection and try again.');
    this.name = 'NetworkError';
  }
}

let csrfRequest: Promise<void> | null = null;

async function ensureCsrf(force = false): Promise<void> {
  if (!force && readCookie(CSRF_COOKIE)) return;
  csrfRequest ??= fetch(`${BASE}/auth/csrf`, { credentials: 'same-origin' })
    .then(() => undefined)
    .finally(() => {
      csrfRequest = null;
    });
  await csrfRequest;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Extra request headers, e.g. the kiosk device token. */
  headers?: Record<string, string>;
  /** Set false for endpoints that do not use the session cookie (kiosk), skipping the CSRF handshake. */
  csrf?: boolean;
}

async function send(path: string, opts: RequestOptions): Promise<Response> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { ...opts.headers, Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (UNSAFE.has(method) && opts.csrf !== false) {
    await ensureCsrf();
    headers['X-CSRF-Token'] = readCookie(CSRF_COOKIE) ?? '';
  }
  try {
    return await fetch(`${BASE}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new NetworkError();
  }
}

/** JSON API call. Throws ApiError for non-2xx responses and NetworkError when offline. */
export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  let res = await send(path, opts);
  if (res.status === 403 && UNSAFE.has(opts.method ?? 'GET')) {
    const body = (await res
      .clone()
      .json()
      .catch(() => null)) as ApiErrorBody | null;
    if (body?.error.code === 'CSRF_INVALID') {
      await ensureCsrf(true);
      res = await send(path, opts);
    }
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'INTERNAL',
      err?.message ?? `Request failed (${res.status})`,
      err?.details,
    );
  }
  return data as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError || err instanceof NetworkError) return err.message;
  return 'Something went wrong. Please try again.';
}
