import { Worker, type Job } from "bullmq";
import { env } from "../config/env.js";
import { createRequestLogger, logger } from "../observability/logger.js";
import { getRedis } from "./redis.js";
import { ordersRepository } from "../modules/orders/orders.repository.js";
import type { CheckoutJobData } from "./queue.js";

const connection = {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
};

const updateMetric = async (field: string, delta: number = 1): Promise<void> => {
    try {
        if (delta === 0) return;
        await getRedis().hincrby("metrics:checkout", field, delta);
    } catch (error) {
        logger.warn({ error, field, delta }, "Failed to update checkout metric");
    }
};

const STOCK_KEY = (productId: string) => `stock:${productId}`;

const processCheckout = async (job: Job<CheckoutJobData>): Promise<void> => {
    const { orderId, productId, quantity, correlationId } = job.data;
    const log = createRequestLogger(correlationId, orderId);

    const spanId = `span-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    log.info(
        {
            spanId,
            component: "worker",
            productId,
            quantity,
            attempt: job.attemptsMade + 1,
        },
        "Processing checkout job",
    );

    await updateMetric("active", 1);

    try {
        await ordersRepository.updateStatus(orderId, "processing");

        await new Promise((resolve) =>
            setTimeout(resolve, env.ERP_PROCESSING_DELAY_MS),
        );

        const shouldFail = Math.random() < 0.1;

        if (shouldFail && job.attemptsMade < job.opts.attempts! - 1) {
            log.warn(
                { spanId, component: "worker" },
                "ERP returned error — will retry",
            );
            throw new Error("ERP_TIMEOUT: billing service did not respond in time");
        }

        if (shouldFail) {
            await ordersRepository.updateStatus(
                orderId,
                "failed",
                "ERP failed after all retries",
            );
            const redis = getRedis();
            await redis.incrby(STOCK_KEY(productId), quantity);
            await updateMetric("failed", 1);
            log.error(
                { spanId, component: "worker" },
                "Checkout failed after all retries — stock replenished",
            );
            return;
        }

        const erpOrderRef = `ERP-${Date.now()}`;
        await ordersRepository.updateStatus(
            orderId,
            "completed",
            undefined,
            erpOrderRef,
        );
        await updateMetric("completed", 1);
        log.info(
            { spanId, component: "worker", erpOrderRef },
            "Checkout completed successfully",
        );
    } finally {
        await updateMetric("active", -1);
    }
};

const start = async () => {
    const redis = getRedis();
    await redis.connect();
    logger.info("Redis connected");

    const worker = new Worker<CheckoutJobData>(
        env.CHECKOUT_QUEUE_NAME,
        processCheckout,
        {
            connection,
            concurrency: 5,
        },
    );

    worker.on("completed", (job) => {
        logger.info(
            { component: "worker", jobId: job.id, orderId: job.data.orderId },
            "Job completed",
        );
    });

    worker.on("failed", (job, err) => {
        logger.error(
            {
                component: "worker",
                jobId: job?.id,
                orderId: job?.data?.orderId,
                err: err.message,
            },
            "Job failed",
        );
    });

    worker.on("error", (err) => {
        logger.error({ component: "worker", err }, "Worker error");
    });

    logger.info(
        `Worker started — listening on queue "${env.CHECKOUT_QUEUE_NAME}"`,
    );

    process.on("SIGTERM", async () => {
        logger.info(
            { component: "worker" },
            "SIGTERM received, closing worker",
        );
        await worker.close();
        process.exit(0);
    });
};

start().catch((err) => {
    logger.error({ component: "worker", err }, "Failed to start worker");
    process.exit(1);
});
