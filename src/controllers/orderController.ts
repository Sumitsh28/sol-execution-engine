import { FastifyRequest, FastifyReply } from "fastify";
import { AppDataSource } from "../config/database";
import { Order } from "../entities/Order";
import { tradeQueue } from "../queue/tradeQueue";
import { redisClient } from "../config/redis";

interface CreateOrderRequest {
  inputMint: string;
  outputMint: string;
  amount: number;
}

export const createOrder = async (
  req: FastifyRequest<{ Body: CreateOrderRequest }>,
  reply: FastifyReply
) => {
  const { inputMint, outputMint, amount } = req.body;

  if (!inputMint || !outputMint || !amount) {
    return reply.status(400).send({ error: "Missing required fields" });
  }

  const idempotencyKey = req.headers["x-idempotency-key"] as string;
  if (idempotencyKey) {
    const existingOrderId = await redisClient.get(
      `idempotency:${idempotencyKey}`
    );
    if (existingOrderId) {
      return reply.send({ orderId: existingOrderId, status: "duplicate" });
    }
  }

  try {
    const orderRepository = AppDataSource.getRepository(Order);
    const newOrder = orderRepository.create({
      inputMint,
      outputMint,
      amount,
      status: "pending",
      logs: [`[${new Date().toISOString()}] Order received`],
    });
    await orderRepository.save(newOrder);

    await tradeQueue.add("execute-trade", { orderId: newOrder.id });

    if (idempotencyKey) {
      await redisClient.set(
        `idempotency:${idempotencyKey}`,
        newOrder.id,
        "EX",
        86400
      );
    }

    return reply.status(201).send({
      orderId: newOrder.id,
      message: "Order queued",
      wsUrl: `ws://localhost:${process.env.PORT || 3000}/ws?orderId=${
        newOrder.id
      }`,
    });
  } catch (error) {
    console.error(error);
    return reply.status(500).send({ error: "Internal Server Error" });
  }
};
