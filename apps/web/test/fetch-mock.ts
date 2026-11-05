import { vi } from 'vitest';

type Handler = (init: RequestInit & { url: string }) => {
  status: number;
  body?: unknown;
  setCookie?: string;
};

/** Minimal fetch router for component tests: `routes['POST /auth/login'] = () => ({...})`. */
export function mockFetch(routes: Record<string, Handler>) {
  const calls: Array<{
    method: string;
    path: string;
    headers: Record<string, string>;
    body: unknown;
  }> = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init.method ?? 'GET').toUpperCase();
    const path = url.replace(/^\/api\/v1/, '');
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({
      method,
      path,
      headers,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const handler = routes[`${method} ${path}`];
    if (!handler)
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not mocked' } }), {
        status: 404,
      });
    const { status, body, setCookie } = handler({ ...init, url });
    if (setCookie) document.cookie = setCookie;
    return new Response(status === 204 ? null : JSON.stringify(body ?? {}), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}
