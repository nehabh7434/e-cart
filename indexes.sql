CREATE INDEX IF NOT EXISTS idx_cart_item_id ON Cart(item_id);
CREATE INDEX IF NOT EXISTS idx_orders_user_date ON Orders(user_id, order_date DESC);
CREATE INDEX IF NOT EXISTS idx_orders_date ON Orders(order_date DESC);
CREATE INDEX IF NOT EXISTS idx_orderitems_product_id ON OrderItems(product_id);
