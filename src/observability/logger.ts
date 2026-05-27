import pino from "pino";
import { env } from "../config/env.js";

export const logger = pino({
    level: env.LOG_LEVEL,
    transport:
        env.NODE_ENV === "development"
            ? {
                  target: "pino-pretty",
                  options: { colorize: true, translateTime: "SYS:standard" },
              }
            : undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
});

export const createRequestLogger = (
    correlationId: string,
    orderId?: string,
) => {
    return logger.child({ correlationId, ...(orderId ? { orderId } : {}) });
};
