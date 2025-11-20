import { FastifyRequest, FastifyReply } from "fastify";
import { AppDataSource } from "../config/database";
import { Order } from "../entities/Order";
import { tradeQueue } from "../queue/tradeQueue";
import { redisClient } from "../config/redis";
import { TokenService } from "../services/tokenService";

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
    return reply.status(400).send({
      error: "Missing required fields: inputMint, outputMint, amount",
    });
  }

  if (amount <= 0) {
    return reply.status(400).send({ error: "Amount must be greater than 0" });
  }

  const idempotencyKey = req.headers["x-idempotency-key"] as string;
  if (idempotencyKey) {
    const existingOrderId = await redisClient.get(
      `idempotency:${idempotencyKey}`
    );
    if (existingOrderId) {
      console.log(`🔁 Idempotency hit for key: ${idempotencyKey}`);
      return reply.status(200).send({
        orderId: existingOrderId,
        message: "Order already received (Idempotent)",
        status: "duplicate",
      });
    }
  }

  try {
    let resolvedInput = inputMint;
    let resolvedOutput = outputMint;

    if (inputMint.length < 10) {
      const mint = await TokenService.getMint(inputMint);
      if (!mint)
        return reply
          .status(400)
          .send({ error: `Unknown token symbol: ${inputMint}` });
      resolvedInput = mint;
    }

    if (outputMint.length < 10) {
      const mint = await TokenService.getMint(outputMint);
      if (!mint)
        return reply
          .status(400)
          .send({ error: `Unknown token symbol: ${outputMint}` });
      resolvedOutput = mint;
    }

    const orderRepository = AppDataSource.getRepository(Order);
    const newOrder = orderRepository.create({
      inputMint: resolvedInput,
      outputMint: resolvedOutput,
      amount,
      status: "pending",
      logs: [
        `[${new Date().toISOString()}] Order received. Input resolved to ${resolvedInput}`,
      ],
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
      message: "Order queued successfully",
      wsUrl: `ws://localhost:${process.env.PORT || 3000}/ws?orderId=${
        newOrder.id
      }`,
    });
  } catch (error) {
    console.error("API Error:", error);
    return reply.status(500).send({ error: "Internal Server Error" });
  }
};
