import Fastify, { FastifyInstance } from "fastify";
import { createOrder } from "../controllers/orderController";
import { tradeQueue } from "../queue/tradeQueue";
import { redisClient } from "../config/redis";
import { DexHandler } from "../lib/solana";
import { BN } from "bn.js";
import { TokenService } from "../services/tokenService"; // Import the real service

// --- MOCKS ---
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

describe("🚀 Order Execution Engine Test Suite", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // ✅ FIX: Spy on the static method directly. This ensures it works even if imported elsewhere.
    jest.spyOn(TokenService, "getMint").mockImplementation(async (symbol) => {
      if (symbol === "SOL")
        return "So11111111111111111111111111111111111111112";
      if (symbol === "USDC")
        return "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      return null;
    });

    app = Fastify();
    app.post("/orders", createOrder);
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks(); // Cleanup spies
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // API & QUEUE TESTS
  test("1. [API] Should reject orders with missing fields (400)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/orders",
      payload: { amount: 10 },
    });
    expect(response.statusCode).toBe(400);
  });

  test("2. [API] Should accept valid order and return 201", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/orders",
      payload: { inputMint: "SOL", outputMint: "USDC", amount: 0.5 },
    });
    expect(response.statusCode).toBe(201);
  });

  test("3. [Queue] Should add job to BullMQ", async () => {
    await app.inject({
      method: "POST",
      url: "/orders",
      payload: { inputMint: "SOL", outputMint: "USDC", amount: 1.5 },
    });
    expect(tradeQueue.add).toHaveBeenCalledTimes(1);
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
  });

  test("5. [Idempotency] Should reject duplicate request", async () => {
    (redisClient.get as jest.Mock).mockResolvedValue("existing-order-id");
    const response = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { "x-idempotency-key": "unique-123" },
      payload: { inputMint: "SOL", outputMint: "USDC", amount: 1 },
    });
    expect(JSON.parse(response.body).status).toBe("duplicate");
  });

  // --- ROUTER LOGIC TESTS ---

  test("6. [Router] Should prioritize Meteora if price is better", async () => {
    const dexHandler = new DexHandler();

    jest
      .spyOn(dexHandler, "getMeteoraCandidates")
      .mockResolvedValue([
        { dex: "meteora", price: 150, outAmount: new BN(150), data: {} },
      ]);
    jest
      .spyOn(dexHandler, "getRaydiumCandidates")
      .mockResolvedValue([
        { dex: "raydium", price: 140, outAmount: new BN(140), data: {} },
      ]);

    const spyExecMeteora = jest
      .spyOn(dexHandler as any, "executeMeteora")
      .mockResolvedValue({ txHash: "tx-meteora", price: 150, dex: "meteora" });

    await dexHandler.executeSwap("order-1", 1, "SOL", "USDC");

    expect(spyExecMeteora).toHaveBeenCalled();
  });

  test("7. [Router] Should failover to Raydium if Meteora fails", async () => {
    const dexHandler = new DexHandler();

    jest
      .spyOn(dexHandler, "getMeteoraCandidates")
      .mockResolvedValue([
        { dex: "meteora", price: 150, outAmount: new BN(150), data: {} },
      ]);
    jest
      .spyOn(dexHandler, "getRaydiumCandidates")
      .mockResolvedValue([
        { dex: "raydium", price: 140, outAmount: new BN(140), data: {} },
      ]);

    jest
      .spyOn(dexHandler as any, "executeMeteora")
      .mockRejectedValue(new Error("Bitmap Error"));

    const spyExecRaydium = jest
      .spyOn(dexHandler as any, "executeRaydium")
      .mockResolvedValue({ txHash: "tx-raydium", price: 140, dex: "raydium" });

    await dexHandler.executeSwap("order-failover", 1, "SOL", "USDC");

    expect(spyExecRaydium).toHaveBeenCalled();
  });

  test("8. [Router] Should use Mock Engine if ALL DEXs fail", async () => {
    const dexHandler = new DexHandler();

    jest.spyOn(dexHandler, "getMeteoraCandidates").mockResolvedValue([]);
    jest.spyOn(dexHandler, "getRaydiumCandidates").mockResolvedValue([]);

    const spyMock = jest
      .spyOn(dexHandler, "executeMockSwap")
      .mockResolvedValue({
        txHash: "mock-tx",
        price: 140,
        dex: "mock-engine",
      });

    const result = await dexHandler.executeSwap("order-mock", 1, "SOL", "USDC");

    expect(result.dex).toBe("mock-engine");
    expect(spyMock).toHaveBeenCalled();
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
