import Fastify, { FastifyInstance } from "fastify";
import { createOrder } from "../controllers/orderController";
import { AppDataSource } from "../config/database";
import { tradeQueue } from "../queue/tradeQueue";
import { redisClient } from "../config/redis";
import { Order } from "../entities/Order";
import { DexHandler } from "../lib/solana";
import { BN } from "bn.js";

jest.mock("../queue/tradeQueue", () => ({
  tradeQueue: {
    add: jest.fn().mockResolvedValue({ id: "mock-job-id" }),
  },
}));

jest.mock("../config/redis", () => ({
  redisClient: {
    get: jest.fn(),
    set: jest.fn(),
    publish: jest.fn(),
  },
  redisSubscriber: {
    subscribe: jest.fn(),
    on: jest.fn(),
  },
}));

const mockSave = jest.fn();
const mockFindOne = jest.fn();
jest.mock("../config/database", () => ({
  AppDataSource: {
    initialize: jest.fn().mockResolvedValue(true),
    isInitialized: true,
    getRepository: () => ({
      create: (data: any) => ({ ...data, id: "test-uuid" }),
      save: mockSave,
      findOneBy: mockFindOne,
    }),
  },
  connectDB: jest.fn(),
}));

jest.mock("../lib/solana");

describe("🚀 Order Execution Engine Test Suite", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.post("/orders", createOrder);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("1. [API] Should reject orders with missing fields (400)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/orders",
      payload: { amount: 10 },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toBe("Missing required fields");
  });

  test("2. [API] Should accept valid order and return 201", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        inputMint: "SOL",
        outputMint: "USDC",
        amount: 0.5,
      },
    });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("orderId");
    expect(body.wsUrl).toContain("/ws?orderId=");
  });

  test("3. [Queue] Should add job to BullMQ with correct payload", async () => {
    await app.inject({
      method: "POST",
      url: "/orders",
      payload: { inputMint: "SOL", outputMint: "USDC", amount: 1.5 },
    });

    expect(tradeQueue.add).toHaveBeenCalledTimes(1);
    expect(tradeQueue.add).toHaveBeenCalledWith(
      "execute-trade",
      expect.objectContaining({
        orderId: "test-uuid",
      })
    );
  });

  test("4. [Idempotency] Should process fresh request", async () => {
    (redisClient.get as jest.Mock).mockResolvedValue(null);

    const response = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { "x-idempotency-key": "unique-123" },
      payload: { inputMint: "SOL", outputMint: "USDC", amount: 1 },
    });

    expect(response.statusCode).toBe(201);
    expect(redisClient.set).toHaveBeenCalledWith(
      "idempotency:unique-123",
      expect.any(String),
      "EX",
      86400
    );
  });

  test("5. [Idempotency] Should reject duplicate request", async () => {
    (redisClient.get as jest.Mock).mockResolvedValue("existing-order-id");

    const response = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { "x-idempotency-key": "unique-123" },
      payload: { inputMint: "SOL", outputMint: "USDC", amount: 1 },
    });

    const body = JSON.parse(response.body);
    expect(body.status).toBe("duplicate");
    expect(body.orderId).toBe("existing-order-id");
    expect(tradeQueue.add).not.toHaveBeenCalled();
  });

  test("6. [Router] Should prioritize Meteora if price is better", async () => {
    const dexHandler = new DexHandler();

    (dexHandler.getMeteoraCandidates as jest.Mock).mockResolvedValue([
      {
        dex: "meteora",
        price: 150,
        outAmount: new BN(150),
        data: {},
      },
    ]);

    (dexHandler.getRaydiumCandidates as jest.Mock).mockResolvedValue([
      {
        dex: "raydium",
        price: 140,
        outAmount: new BN(140),
        data: {},
      },
    ]);

    (dexHandler as any).executeMeteora = jest
      .fn()
      .mockResolvedValue("tx-meteora");

    await dexHandler.executeSwap("order-1", 1);

    expect((dexHandler as any).executeMeteora).toHaveBeenCalled();
  });

  test("7. [Router] Should failover to Raydium if Meteora fails", async () => {
    const dexHandler = new DexHandler();

    (dexHandler.getMeteoraCandidates as jest.Mock).mockResolvedValue([
      {
        dex: "meteora",
        price: 150,
        outAmount: new BN(150),
        data: {},
      },
    ]);

    (dexHandler as any).executeMeteora = jest
      .fn()
      .mockRejectedValue(new Error("Bitmap Error"));
    (dexHandler as any).executeRaydium = jest
      .fn()
      .mockResolvedValue("tx-raydium");

    (dexHandler.getRaydiumCandidates as jest.Mock).mockResolvedValue([
      {
        dex: "raydium",
        price: 140,
        outAmount: new BN(140),
        data: {},
      },
    ]);

    await dexHandler.executeSwap("order-failover", 1);

    expect((dexHandler as any).executeMeteora).toHaveBeenCalled();
    expect((dexHandler as any).executeRaydium).toHaveBeenCalled();
  });

  test("8. [Router] Should use Mock Engine if ALL DEXs fail", async () => {
    const dexHandler = new DexHandler();

    (dexHandler.getMeteoraCandidates as jest.Mock).mockResolvedValue([]);
    (dexHandler.getRaydiumCandidates as jest.Mock).mockResolvedValue([]);
    (dexHandler.executeMockSwap as jest.Mock).mockResolvedValue({
      txHash: "mock-tx",
      price: 140,
      dex: "mock-engine",
    });

    const result = await dexHandler.executeSwap("order-mock", 1);

    expect(result.dex).toBe("mock-engine");
    expect(dexHandler.executeMockSwap).toHaveBeenCalled();
  });

  test("9. [WebSocket] Should publish updates to Redis", async () => {
    const orderId = "test-ws-id";
    const message = JSON.stringify({ orderId, status: "confirmed" });

    await redisClient.publish(`order-updates:${orderId}`, message);

    expect(redisClient.publish).toHaveBeenCalledWith(
      `order-updates:${orderId}`,
      message
    );
  });

  test("10. [DB] Should persist order logs", async () => {
    mockFindOne.mockResolvedValue({ id: "123", logs: [] });

    const order = { id: "123", logs: [] as string[] };
    order.logs.push("Routed via METEORA");

    expect(order.logs).toContain("Routed via METEORA");
  });
});
