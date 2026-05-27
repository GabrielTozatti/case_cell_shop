import { Router, type Request, type Response } from "express";
import { ordersRepository } from "./orders.repository.js";
import { createRequestLogger } from "../../observability/logger.js";

export const ordersRouter = Router();

ordersRouter.get("/:orderId/status", async (req: Request, res: Response) => {
    const { orderId } = req.params;
    const { correlationId } = res.locals;
    const log = createRequestLogger(correlationId, orderId);

    const order = await ordersRepository.findById(orderId);

    if (!order) {
        log.warn({ component: "orders-router", orderId }, "Order not found");
        res.status(404).json({
            error: "ORDER_NOT_FOUND",
            message: `Order ${orderId} not found`,
            correlationId,
        });
        return;
    }

    const isTerminal =
        order.status === "completed" || order.status === "failed";

    log.info(
        { component: "orders-router", orderId, status: order.status },
        "Order status polled",
    );

    res.status(200).json({
        orderId: order.orderId,
        status: order.status,
        productId: order.productId,
        quantity: order.quantity,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        ...(order.erpOrderRef ? { erpOrderRef: order.erpOrderRef } : {}),
        ...(order.errorMessage ? { errorMessage: order.errorMessage } : {}),
        correlationId,
        _links: {
            ...(!isTerminal ? { poll: `/orders/${orderId}/status` } : {}),
        },
    });
});
