/**
 * Fills runtime defaults that Vercel can supply on its own, so the deployment needs fewer
 * hand-maintained variables. Explicitly set values always win; nothing here weakens a
 * production requirement (the env schema still rejects an insecure configuration).
 */
export function applyVercelEnvDefaults(source: NodeJS.ProcessEnv): void {
  if (!source.VERCEL) return;

  // The SPA and the API share one origin on Vercel, so the production domain is the CORS origin.
  if (!source.WEB_ORIGIN && source.VERCEL_PROJECT_PRODUCTION_URL) {
    source.WEB_ORIGIN = `https://${source.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  // Vercel's edge sets X-Forwarded-For itself (it does not forward a client-supplied value),
  // so exactly one proxy hop is trusted for the client IP used by rate limiting and audit logs.
  source.TRUST_PROXY_HOPS ??= '1';
  // Vercel always serves over HTTPS.
  source.COOKIE_SECURE ??= 'true';
}
