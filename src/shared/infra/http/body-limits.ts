import type { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { json } from 'express';

/** `PUT /hub/agent/tools`: up to 200 tools in ONE replacing request (spec pc-agent §5.4), so the body cannot be split. */
export const AGENT_TOOLS_BODY_MAX_BYTES = 2 * 1024 * 1024;

/**
 * `PUT /organizations/:orgId/agent-policy`: up to 500 rules in ONE replacing request (spec pc-agent §5.5). A rule is
 * small (~150 bytes), but a path is up to 1024 characters (3 bytes each in UTF-8) and a user id 128, so the worst case
 * is ~1.7 MB: the same 2 MiB as the catalog.
 */
export const AGENT_POLICY_BODY_MAX_BYTES = 2 * 1024 * 1024;

/**
 * `POST /hub/conversations/:id/brain/step`: the history (up to 40 messages) and the previous turns of the answer with
 * their tool results (each up to 32 KiB) in one request (spec pc-agent §5.3). Same value as `BRAIN_BODY_MAX_BYTES` (the
 * cloud domain, which `shared` does not import).
 */
export const BRAIN_STEP_BODY_MAX_BYTES = 256 * 1024;

export type JsonBodyLimit = {
  method: string;
  /** Exact path (no query string, no trailing slash) or a RegExp tested against the path. */
  path: string | RegExp;
  limitBytes: number;
};

/**
 * Routes whose JSON body may exceed Express's default (100 kB). Everything else keeps the default. A route that needs
 * more adds its entry here.
 */
export const JSON_BODY_LIMITS: readonly JsonBodyLimit[] = [
  {
    method: 'PUT',
    path: '/hub/agent/tools',
    limitBytes: AGENT_TOOLS_BODY_MAX_BYTES,
  },
  {
    method: 'PUT',
    path: /^\/organizations\/[^/]+\/agent-policy$/,
    limitBytes: AGENT_POLICY_BODY_MAX_BYTES,
  },
  {
    method: 'POST',
    path: /^\/hub\/conversations\/[^/]+\/brain\/step$/,
    limitBytes: BRAIN_STEP_BODY_MAX_BYTES,
  },
];

const matches = (rule: JsonBodyLimit, req: Request) =>
  rule.method === req.method &&
  (typeof rule.path === 'string'
    ? req.path === rule.path
    : rule.path.test(req.path));

/**
 * Registers, BEFORE Nest's own JSON parser (it is added at `init()`, and the first parser to read a body wins), one
 * `express.json({ limit })` per entry that only acts on its route. Too large: the parser's 413 (same problem+json as the
 * default limit). Call it before `app.init()`; `configureApp` does, for the real bootstrap and the e2e.
 */
export function applyJsonBodyLimits(
  app: INestApplication,
  limits: readonly JsonBodyLimit[] = JSON_BODY_LIMITS,
): void {
  for (const rule of limits) {
    const parser = json({ limit: rule.limitBytes });
    app
      .getHttpAdapter()
      .getInstance()
      .use((req: Request, res: Response, next: NextFunction) =>
        matches(rule, req) ? parser(req, res, next) : next(),
      );
  }
}
