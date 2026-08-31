import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Express 4 does not catch rejected promises from async handlers, so an
 * unhandled rejection becomes a hung request. Wrapping every async handler is
 * the cheapest way to guarantee errors reach the error middleware.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
