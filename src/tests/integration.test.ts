process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import Fastify, { FastifyInstance } from "fastify";
import WebSocket from "ws";
import websocket from "@fastify/websocket";
import { createOrder } from "../controllers/orderController";
import { AppDataSource } from "../config/database";
import { tradeQueue } from "../queue/tradeQueue";
import { Order } from "../entities/Order";
import { DexHandler } from "../lib/solana";
import { Worker } from "bullmq";
import Redis from "ioredis";
import dotenv from "dotenv";

dotenv.config();

jest.setTimeout(90000);

describe("🔥 REAL End-to-End System Test", () => {
  let server: FastifyInstance;
  let worker: Worker | undefined;
  let wsClient: WebSocket;

  const socketMap = new Map<string, any>();
  let globalSubscriber: Redis;
  let testRedisPub: Redis;
  const orderRepo = AppDataSource.getRepository(Order);

  const startWorker = () => {
    const dexHandler = new DexHandler();
    return new Worker(
      "trade-queue",
      async (job) => {
        const { orderId } = job.data;
        const order = await orderRepo.findOneBy({ id: orderId });
        if (!order) return;

        try {
          console.log(`[Test Worker] Processing ${orderId}...`);
          const result = await dexHandler.executeSwap(
            orderId,
            Number(order.amount),
            order.inputMint,
            order.outputMint
          );

          order.status = "confirmed";
          order.txHash = result.txHash;
          order.executedPrice = result.price;
          await orderRepo.save(order);

          const msg = JSON.stringify({ status: "confirmed", ...result });
          await testRedisPub.publish(`order-updates:${orderId}`, msg);
          console.log(`[Test Worker] Published CONFIRMED`);
        } catch (e: any) {
          console.error("[Test Worker] Failed:", e);
        }
      },
      { connection: { host: "localhost", port: 6379 } }
    );
  };

  beforeAll(async () => {
    globalSubscriber = new Redis({ host: "localhost", port: 6379 });
    testRedisPub = new Redis({ host: "localhost", port: 6379 });

    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    await orderRepo.clear();

    await tradeQueue.pause();
    await tradeQueue.drain();
    await tradeQueue.obliterate({ force: true });

    server = Fastify();
    await server.register(websocket);
    await server.register(require("@fastify/cors"));
    server.post("/api/orders/execute", createOrder);

    server.get("/ws", { websocket: true }, (connection: any, req: any) => {
      const { orderId } = req.query as { orderId: string };
      console.log(`[Test Server] Connected: ${orderId}`);
      socketMap.set(orderId, connection.socket);
      globalSubscriber.subscribe(`order-updates:${orderId}`);

      connection.socket.on("close", () => {
        socketMap.delete(orderId);
        globalSubscriber.unsubscribe(`order-updates:${orderId}`);
      });
    });

    globalSubscriber.on("message", async (channel, msg) => {
      const orderId = channel.split(":")[1];
      const targetSocket = socketMap.get(orderId);

      if (targetSocket && targetSocket.readyState === 1) {
        targetSocket.send(msg);
        console.log(`[Test Server] -> Sent to Client`);
      } else {
        console.warn(
          `[Test Server] ORPHAN MSG: Socket not ready for ${orderId}`
        );
      }
    });

    await server.listen({ port: 3002, host: "0.0.0.0" });
  });

  afterAll(async () => {
    if (worker) await worker.close();
    if (server) await server.close();
    if (globalSubscriber) await globalSubscriber.quit();
    if (testRedisPub) await testRedisPub.quit();
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  });

  test("👉 Full Lifecycle: API -> Queue -> Worker -> Blockchain -> WebSocket", async () => {
    return new Promise<void>(async (resolve, reject) => {
      try {
        const response = await server.inject({
          method: "POST",
          url: "/api/orders/execute",
          payload: {
            inputMint: "So11111111111111111111111111111111111111112",
            outputMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
            amount: 0.01,
          },
        });

        const { orderId } = JSON.parse(response.payload);
        console.log(`[Test] Order Queued: ${orderId}`);

        wsClient = new WebSocket(`ws://localhost:3002/ws?orderId=${orderId}`);

        wsClient.on("open", async () => {
          console.log("[Test] WS Connected. Starting Worker now...");

          worker = startWorker();
        });

        wsClient.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          console.log(`[Test Client] Status: ${msg.status}`);

          if (msg.status === "confirmed") {
            console.log("✅ PASSED");
            wsClient.close();
            resolve();
          }
        });

        wsClient.on("error", (err) => reject(err));
      } catch (err) {
        reject(err);
      }
    });
  });

  test("👉 Idempotency", async () => {
    const key = `test-${Date.now()}`;
    const res1 = await server.inject({
      method: "POST",
      url: "/api/orders/execute",
      headers: { "x-idempotency-key": key },
      payload: { inputMint: "SOL", outputMint: "USDC", amount: 0.01 },
    });
    expect(res1.statusCode).toBe(201);

    const res2 = await server.inject({
      method: "POST",
      url: "/api/orders/execute",
      headers: { "x-idempotency-key": key },
      payload: { inputMint: "SOL", outputMint: "USDC", amount: 0.01 },
    });
    expect(JSON.parse(res2.payload).status).toBe("duplicate");
  });
});
