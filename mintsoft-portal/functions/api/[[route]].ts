/**
 * Cloudflare Pages Function entry point.
 *
 * Everything under /api/* reaches the Hono app. The static React build is served by
 * Pages itself, so this file only exists to hand requests over.
 */
import { createApp } from '../../src/server/app.ts'
import type { Env } from '../../src/server/auth/middleware.ts'

const app = createApp()

export const onRequest: PagesFunction<Env> = (context) =>
  // Pages hands us an EventContext; Hono wants the two scheduling methods off it.
  app.fetch(context.request, context.env, {
    waitUntil: context.waitUntil.bind(context),
    passThroughOnException: context.passThroughOnException.bind(context),
    props: {},
  })
