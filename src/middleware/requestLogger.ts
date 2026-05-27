import type { Request, Response, NextFunction } from "express";
import { logger } from "../observability/logger.js";

export const requestLoggerMiddleware = (
    req: Request,
    res: Response,
    next: NextFunction,
): void => {
    const start = Date.now();
    const { method, url } = req;
    const correlationId = res.locals.correlationId;

    res.on("finish", () => {
        const durationMs = Date.now() - start;
        const level =
            res.statusCode >= 500
                ? "error"
                : res.statusCode >= 400
                  ? "warn"
                  : "info";

        logger[level](
            {
                correlationId,
                method,
                url,
                statusCode: res.statusCode,
                durationMs,
            },
            `${method} ${url} ${res.statusCode} — ${durationMs}ms`,
        );
    });

    next();
};
