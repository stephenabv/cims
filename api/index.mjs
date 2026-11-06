// Vercel function for the CIMS API. Every /api/* request is rewritten here (see vercel.json).
// The NestJS app is compiled by the build step (apps/api/dist); this file only adapts it.
import serverless from '../apps/api/dist/serverless/handler.js';

export default serverless.handler;
