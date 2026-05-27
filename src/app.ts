import express, { type Request, type Response } from "express";
import swaggerUi from "swagger-ui-express";
import { readFileSync } from "fs";
import { parse } from "yaml";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { correlationIdMiddleware } from "./middleware/correlationId.js";
import { requestLoggerMiddleware } from "./middleware/requestLogger.js";
import { productsRouter } from "./modules/products/products.routes.js";
import { checkoutRouter } from "./modules/checkout/checkout.routes.js";
import { ordersRouter } from "./modules/orders/orders.routes.js";
import { metrics } from "./observability/metrics.js";
import { getRedis } from "./infra/redis.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const swaggerSpec = parse(
    readFileSync(join(__dirname, "openapi/spec.yaml"), "utf-8"),
);

export const createApp = () => {
    const app = express();

    app.use(express.json());
    app.use(correlationIdMiddleware);
    app.use(requestLoggerMiddleware);

    app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

    app.use("/products", productsRouter);
    app.use("/checkout", checkoutRouter);
    app.use("/orders", ordersRouter);

    app.get("/metrics", async (_req: Request, res: Response) => {
        const base = metrics.snapshot();
        try {
            const redis = getRedis();
            const workerMetrics = await redis.hgetall("metrics:checkout");
            const completed = parseInt(workerMetrics?.completed ?? "0", 10);
            const failed = parseInt(workerMetrics?.failed ?? "0", 10);
            const active = parseInt(workerMetrics?.active ?? "0", 10);
            res.status(200).json({
                ...base,
                checkout: {
                    ...base.checkout,
                    completed,
                    failed,
                },
                queue: {
                    waiting: Math.max(
                        0,
                        base.checkout.enqueued - completed - failed - active,
                    ),
                    active,
                },
            });
        } catch {
            res.status(200).json(base);
        }
    });

    app.get("/health", (_req: Request, res: Response) => {
        res.status(200).json({ status: "ok", ts: new Date().toISOString() });
    });

    app.use((req: Request, res: Response) => {
        res.status(404).json({
            error: "NOT_FOUND",
            message: `Route ${req.method} ${req.path} not found`,
        });
    });

    return app;
};
