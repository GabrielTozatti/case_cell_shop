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

const incrementMetric = async (field: string): Promise<void> => {
    try {
        await getRedis().hincrby("metrics:checkout", field, 1);
    } catch (error) {
        logger.warn(
            {
                error,
                field,
            },
            "Failed to increment checkout metric",
        );
    }
};

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

    await incrementMetric("active");

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
        await incrementMetric("failed");
        log.error(
            { spanId, component: "worker" },
            "Checkout failed after all retries",
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
    await incrementMetric("completed");
    log.info(
        { spanId, component: "worker", erpOrderRef },
        "Checkout completed successfully",
    );
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
