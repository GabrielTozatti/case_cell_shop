import type { Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";

declare global {
    namespace Express {
        interface Locals {
            correlationId: string;
        }
    }
}

export const correlationIdMiddleware = (
    req: Request,
    res: Response,
    next: NextFunction,
): void => {
    const existing = req.headers["x-correlation-id"];
    const correlationId =
        typeof existing === "string" && existing.length > 0
            ? existing
            : uuidv4();

    res.locals.correlationId = correlationId;
    res.setHeader("X-Correlation-ID", correlationId);

    next();
};
