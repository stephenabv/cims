import 'reflect-metadata';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from '../app.module';
import { configureApp } from '../app.setup';
import { loadEnv } from '../common/config/env';
import { applyVercelEnvDefaults } from './vercel-env';

type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;

let listener: Promise<RequestListener> | undefined;

/**
 * Builds the Nest application once per function instance and reuses it for every request the
 * instance serves. Uses the same hardening as main.ts (configureApp); only `listen` is replaced
 * by `init`, because the platform owns the HTTP server.
 */
async function createListener(): Promise<RequestListener> {
  applyVercelEnvDefaults(process.env);
  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  configureApp(app, env);
  await app.init();
  return app.getHttpAdapter().getInstance() as RequestListener;
}

function getListener(): Promise<RequestListener> {
  listener ??= createListener().catch((err: unknown) => {
    // Do not cache a failed bootstrap (e.g. a transient database outage): retry on the next request.
    listener = undefined;
    throw err;
  });
  return listener;
}

/** Vercel Node.js function entry point for every /api/* request. */
export async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let app: RequestListener;
  try {
    app = await getListener();
  } catch (err) {
    // Configuration details stay in the function log, never in the response.
    console.error('CIMS API failed to start', err);
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({ statusCode: 503, message: 'Service temporarily unavailable' }));
    return;
  }
  app(req, res);
}
