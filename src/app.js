import { Hono } from 'hono';
import { createVerifyHandler } from './verify.js';

export function createApp({ db, diagnostics, config }) {
  const app = new Hono();

  app.get('/:filename{[^/]+\\.txt}', createVerifyHandler({ db, diagnostics }));

  app.notFound((c) =>
    c.body('Not found', 404, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    })
  );

  return app;
}
