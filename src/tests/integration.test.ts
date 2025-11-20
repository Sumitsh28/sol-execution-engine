import Fastify, { FastifyInstance } from "fastify";
import WebSocket from "ws";
import websocket from "@fastify/websocket";
import { createOrder } from "../controllers/orderController";
import { AppDataSource } from "../config/database";
import { tradeQueue } from "../queue/tradeQueue";
import { redisClient, redisSubscriber } from "../config/redis";
import { Order } from "../entities/Order";
import { DexHandler } from "../lib/solana";
import { Worker } from "bullmq";
import dotenv from "dotenv";

dotenv.config();

jest.setTimeout(60000);

describe("🔥 REAL End-to-End System Test", () => {
  let server: FastifyInstance;
  let worker: Worker;
  let wsClient: WebSocket;
  const subscribers: any[] = [];

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();

    const orderRepo = AppDataSource.getRepository(Order);
    await orderRepo.clear();
    await tradeQueue.drain();
    await tradeQueue.obliterate();

    server = Fastify();
    await server.register(websocket);
    await server.register(require("@fastify/cors"));

    server.post("/orders", createOrder);

    server.get("/ws", { websocket: true }, (connection: any, req: any) => {
      const { orderId } = req.query as { orderId: string };

      const sub = redisSubscriber.duplicate();
      subscribers.push(sub);

      sub.subscribe(`order-updates:${orderId}`);

      sub.on("message", (channel, msg) => {
        if (connection.socket && connection.socket.readyState === 1) {
          connection.socket.send(msg);
        }
      });

      connection.socket.on("close", () => {
        sub.quit();
      });
    });

    await server.listen({ port: 3002, host: "0.0.0.0" });

    const dexHandler = new DexHandler();

    worker = new Worker(
      "trade-queue",
      async (job) => {
        const { orderId } = job.data;
        const order = await orderRepo.findOneBy({ id: orderId });
        if (!order) return;

        try {
          console.log(`[Test Worker] Processing ${orderId}`);
          const result = await dexHandler.executeSwap(orderId, order.amount);

          order.status = "confirmed";
          order.txHash = result.txHash;
          order.executedPrice = result.price;
          await orderRepo.save(order);

          const updateMsg = JSON.stringify({ status: "confirmed", ...result });
          await redisClient.publish(`order-updates:${orderId}`, updateMsg);
          console.log(`[Test Worker] Published update for ${orderId}`);
        } catch (e: any) {
          console.error(`[Test Worker] Failed: ${e.message}`);
          order.status = "failed";
          order.error = e.message;
          await orderRepo.save(order);
        }
      },
      { connection: { host: "localhost", port: 6379 } }
    );
  });

  afterAll(async () => {
    for (const sub of subscribers) {
      await sub.quit();
    }
    await server.close();
    await worker.close();
    await AppDataSource.destroy();
    await redisClient.quit();
    await redisSubscriber.quit();
  });

  test("👉 Full Lifecycle: API -> Queue -> Worker -> Blockchain -> WebSocket", async () => {
    return new Promise<void>(async (resolve, reject) => {
      try {
        const response = await server.inject({
          method: "POST",
          url: "/orders",
          payload: {
            inputMint: "So11111111111111111111111111111111111111112",
            outputMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
            amount: 0.01,
          },
        });

        expect(response.statusCode).toBe(201);
        const { orderId } = JSON.parse(response.payload);
        console.log(`Test Order ID: ${orderId}`);

        wsClient = new WebSocket(`ws://localhost:3002/ws?orderId=${orderId}`);

        const timeout = setTimeout(() => {
          wsClient.close();
          reject(new Error("Test Timed Out waiting for WS update"));
        }, 55000);

        wsClient.on("open", () => {
          console.log("Test WS Connected");
        });

        wsClient.on("message", async (data) => {
          const msg = JSON.parse(data.toString());
          console.log("Test WS Received:", msg);

          if (msg.status === "confirmed") {
            clearTimeout(timeout);

            const repo = AppDataSource.getRepository(Order);
            const savedOrder = await repo.findOneBy({ id: orderId });

            expect(savedOrder).toBeDefined();
            expect(savedOrder?.status).toBe("confirmed");
            expect(savedOrder?.txHash).toBeDefined();

            console.log("✅ Lifecycle Test Passed");
            wsClient.close();
            resolve();
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  });

  test("👉 Idempotency: Prevent Double Submission", async () => {
    const key = `test-key-${Date.now()}`;

    const res1 = await server.inject({
      method: "POST",
      url: "/orders",
      headers: { "x-idempotency-key": key },
      payload: { inputMint: "SOL", outputMint: "USDC", amount: 0.01 },
    });
    const id1 = JSON.parse(res1.payload).orderId;

    const res2 = await server.inject({
      method: "POST",
      url: "/orders",
      headers: { "x-idempotency-key": key },
      payload: { inputMint: "SOL", outputMint: "USDC", amount: 0.01 },
    });
    const body2 = JSON.parse(res2.payload);

    expect(res1.statusCode).toBe(201);
    expect(body2.status).toBe("duplicate");
    expect(body2.orderId).toBe(id1);
  });
});
