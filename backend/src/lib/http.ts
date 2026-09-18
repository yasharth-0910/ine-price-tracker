// Express 4 doesn't catch rejections from async handlers, so wrap them and forward to the error
// middleware instead of leaving the request hanging.
import type { Request, Response, RequestHandler } from 'express';

export const asyncHandler =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };
