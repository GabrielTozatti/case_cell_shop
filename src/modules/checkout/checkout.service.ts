import { getRedis } from "../../infra/redis.js";
import { getCheckoutQueue, type CheckoutJobData } from "../../infra/queue.js";
import { metrics } from "../../observability/metrics.js";
import { createRequestLogger } from "../../observability/logger.js";
import { ordersRepository, type Order } from "../orders/orders.repository.js";
import { productsRepository } from "../products/products.repository.js";
import { v4 as uuidv4 } from "uuid";

export interface CheckoutInput {
    productId: string;
    quantity: number;
    idempotencyKey: string;
}

export type CheckoutResult =
    | { success: true; order: Order; idempotent: boolean }
    | {
          success: false;
          reason:
              | "PRODUCT_NOT_FOUND"
              | "INSUFFICIENT_STOCK"
              | "INVALID_QUANTITY";
          message: string;
      };

const STOCK_KEY = (productId: string) => `stock:${productId}`;
const IDEMPOTENCY_TTL = 86400;

export const checkoutService = {
    async initiateCheckout(
        input: CheckoutInput,
        correlationId: string,
    ): Promise<CheckoutResult> {
        const log = createRequestLogger(correlationId);
        const spanId = `span-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        const { productId, quantity, idempotencyKey } = input;

        if (quantity < 1 || !Number.isInteger(quantity)) {
            return {
                success: false,
                reason: "INVALID_QUANTITY",
                message: "Quantity must be a positive integer",
            };
        }

        const existingOrder =
            await ordersRepository.findByIdempotencyKey(idempotencyKey);
        if (existingOrder) {
            log.info(
                {
                    spanId,
                    component: "checkout-service",
                    orderId: existingOrder.orderId,
                },
                "Idempotent request — returning existing order",
            );
            return { success: true, order: existingOrder, idempotent: true };
        }

        const product = await productsRepository.findById(productId);
        if (!product) {
            log.warn(
                { spanId, component: "checkout-service", productId },
                "Product not found",
            );
            return {
                success: false,
                reason: "PRODUCT_NOT_FOUND",
                message: `Product ${productId} not found`,
            };
        }

        const redis = getRedis();
        const stockKey = STOCK_KEY(productId);

        await redis.set(stockKey, product.stock, "EX", IDEMPOTENCY_TTL, "NX");

        const remaining = await redis.decrby(stockKey, quantity);

        if (remaining < 0) {
            await redis.incrby(stockKey, quantity);
            metrics.oversellBlocked();
            log.warn(
                {
                    spanId,
                    component: "checkout-service",
                    productId,
                    quantity,
                    remaining,
                },
                "Oversell blocked — insufficient stock",
            );
            return {
                success: false,
                reason: "INSUFFICIENT_STOCK",
                message: `Insufficient stock for product ${productId}. Requested: ${quantity}`,
            };
        }

        const orderId = `ord-${uuidv4()}`;
        const now = new Date().toISOString();

        const order: Order = {
            orderId,
            productId,
            quantity,
            status: "pending",
            idempotencyKey,
            correlationId,
            createdAt: now,
            updatedAt: now,
        };

        await ordersRepository.create(order);
        log.info(
            {
                spanId,
                component: "checkout-service",
                orderId,
                productId,
                quantity,
                stockRemaining: remaining,
            },
            "Order created, stock reserved",
        );

        const jobData: CheckoutJobData = {
            orderId,
            productId,
            quantity,
            correlationId,
        };
        const queue = getCheckoutQueue();
        await queue.add("process-checkout", jobData, { jobId: orderId });

        metrics.checkoutEnqueued();
        log.info(
            { spanId, component: "checkout-service", orderId },
            "Checkout job enqueued",
        );

        return { success: true, order, idempotent: false };
    },
};
