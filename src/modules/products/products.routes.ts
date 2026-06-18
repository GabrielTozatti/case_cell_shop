import { Router, type Request, type Response } from "express";
import { productsService } from "./products.service.js";
import { createRequestLogger } from "../../observability/logger.js";

export const productsRouter = Router();

productsRouter.get("/", async (req: Request, res: Response) => {
    const { correlationId } = res.locals;
    const log = createRequestLogger(correlationId);

    try {
        const { products, fromCache } = await productsService.getAll(
            correlationId,
        );

        res.setHeader("X-Cache", fromCache ? "HIT" : "MISS");
        res.setHeader("Cache-Control", "public, max-age=60");

        res.status(200).json({
            data: products,
            meta: {
                count: products.length,
                cachedResponse: fromCache,
                correlationId,
            },
        });
    } catch (err) {
        log.error(
            { component: "products-router", err },
            "Failed to fetch products",
        );
        res.status(503).json({
            error: "SERVICE_UNAVAILABLE",
            message: "Could not fetch product catalog",
            correlationId,
        });
    }
});
