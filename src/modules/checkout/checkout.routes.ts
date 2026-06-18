import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { checkoutService } from "./checkout.service.js";
import { createRequestLogger } from "../../observability/logger.js";

const checkoutSchema = z.object({
    productId: z.string().min(1, "productId is required"),
    quantity: z.number().int().positive("quantity must be a positive integer"),
    idempotencyKey: z.string().min(1, "idempotencyKey is required"),
});

export const checkoutRouter = Router();

checkoutRouter.post("/", async (req: Request, res: Response) => {
    const { correlationId } = res.locals;
    const log = createRequestLogger(correlationId);

    if (!req.body || typeof req.body !== "object") {
        res.status(415).json({
            error: "UNSUPPORTED_MEDIA_TYPE",
            message: "Request body must be valid JSON with Content-Type: application/json",
            correlationId,
        });
        return;
    }

    const parsed = checkoutSchema.safeParse(req.body);
    if (!parsed.success) {
        const firstIssue = parsed.error.issues[0];
        res.status(400).json({
            error: "VALIDATION_ERROR",
            message: firstIssue.message,
            correlationId,
        });
        return;
    }

    const { productId, quantity, idempotencyKey } = parsed.data;

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
