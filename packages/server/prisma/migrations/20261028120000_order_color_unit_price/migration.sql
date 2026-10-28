-- A colour's own rate, for a PO that prices each style; null keeps the order's price.
ALTER TABLE "order_colors" ADD COLUMN "unitPriceUsd" DECIMAL(10,4);
