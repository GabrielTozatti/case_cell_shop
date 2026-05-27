import { Queue } from "bullmq";
import { env } from "../config/env.js";

export interface CheckoutJobData {
    orderId: string;
    productId: string;
    quantity: number;
    correlationId: string;
}

const connection = {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
};

let _queue: Queue<CheckoutJobData> | null = null;

export const getCheckoutQueue = (): Queue<CheckoutJobData> => {
    if (!_queue) {
        _queue = new Queue<CheckoutJobData>(env.CHECKOUT_QUEUE_NAME, {
            connection,
            defaultJobOptions: {
                attempts: 3,
                backoff: { type: "exponential", delay: 1000 },
                removeOnComplete: { count: 100 },
                removeOnFail: { count: 50 },
            },
        });
    }
    return _queue;
};

export const closeQueue = async (): Promise<void> => {
    if (_queue) {
        await _queue.close();
        _queue = null;
    }
};
