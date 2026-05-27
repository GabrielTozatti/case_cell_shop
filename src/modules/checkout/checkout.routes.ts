import { Router, type Request, type Response } from "express";
import { checkoutService } from "./checkout.service.js";
import { createRequestLogger } from "../../observability/logger.js";

export const checkoutRouter = Router();

checkoutRouter.post("/", async (req: Request, res: Response) => {
    const { correlationId } = res.locals;
    const log = createRequestLogger(correlationId);

    const { productId, quantity, idempotencyKey } = req.body;

    if (!productId || typeof productId !== "string") {
        res.status(400).json({
            error: "VALIDATION_ERROR",
            message: "productId is required",
            correlationId,
        });
        return;
    }
    if (!idempotencyKey || typeof idempotencyKey !== "string") {
        res.status(400).json({
            error: "VALIDATION_ERROR",
            message: "idempotencyKey is required",
            correlationId,
        });
        return;
    }
    if (quantity === undefined || quantity === null) {
        res.status(400).json({
            error: "VALIDATION_ERROR",
            message: "quantity is required",
            correlationId,
        });
        return;
    }

    try {
        const result = await checkoutService.initiateCheckout(
            { productId, quantity, idempotencyKey },
            correlationId,
        );

        if (!result.success) {
            const statusCode =
                result.reason === "PRODUCT_NOT_FOUND"
                    ? 404
                    : result.reason === "INSUFFICIENT_STOCK"
                      ? 409
                      : 422;

            log.warn(
                { component: "checkout-router", reason: result.reason },
                result.message,
            );
            res.status(statusCode).json({
                error: result.reason,
                message: result.message,
                correlationId,
            });
            return;
        }

        const { order, idempotent } = result;

        res.status(202)
            .setHeader("X-Idempotent-Replay", idempotent ? "true" : "false")
            .json({
                orderId: order.orderId,
                status: order.status,
                message: idempotent
                    ? "Idempotent request — returning existing order"
                    : "Order accepted and queued for processing",
                correlationId,
                _links: {
                    status: `/orders/${order.orderId}/status`,
                },
            });
    } catch (err) {
        log.error(
            { component: "checkout-router", err },
            "Unexpected error during checkout",
        );
        res.status(500).json({
            error: "INTERNAL_ERROR",
            message: "An unexpected error occurred",
            correlationId,
        });
    }
});
