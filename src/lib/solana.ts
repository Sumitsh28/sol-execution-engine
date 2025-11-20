import {
  Connection,
  Keypair,
  PublicKey,
  ComputeBudgetProgram,
  TransactionInstruction,
  Transaction,
} from "@solana/web3.js";
import DLMM from "@meteora-ag/dlmm";
import { Raydium } from "@raydium-io/raydium-sdk-v2";
import { BN } from "bn.js";
import dotenv from "dotenv";
import bs58 from "bs58";
import { randomUUID } from "crypto";

dotenv.config();

const RAYDIUM_PROGRAM_ID = new PublicKey(
  "HWy1jotHpo6UqeQxx49dpYYdQB8wj9Qk9MdxwjLvDHB8"
);

type RouteQuote = {
  dex: "meteora" | "raydium" | "mock";
  price: number;
  outAmount: InstanceType<typeof BN>;
  data: any;
};

class VirtualAMM {
  getQuote(amountIn: number) {
    const price = 1.0 + (Math.random() * 0.05 - 0.025);
    const amountOut = amountIn * price;
    return {
      outAmount: amountOut,
      price: price,
    };
  }
}

export class DexHandler {
  connection: Connection;
  wallet: Keypair;
  raydium: Raydium | undefined;
  virtualPool: VirtualAMM;

  constructor() {
    this.connection = new Connection(
      process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
      "confirmed"
    );
    this.virtualPool = new VirtualAMM();

    const pkString = process.env.WALLET_PRIVATE_KEY!;
    try {
      let secretKey: Uint8Array;
      if (pkString.includes("[")) {
        secretKey = Uint8Array.from(JSON.parse(pkString));
      } else {
        secretKey = bs58.decode(pkString);
      }
      this.wallet = Keypair.fromSecretKey(secretKey);
    } catch (e) {
      console.error("❌ Invalid Private Key format in .env");
      process.exit(1);
    }
  }

  async initRaydium() {
    if (this.raydium) return;
    this.raydium = await Raydium.load({
      owner: this.wallet,
      connection: this.connection,
      cluster: "devnet",
      disableFeatureCheck: true,
      blockhashCommitment: "finalized",
    });
  }

  async getDynamicPriorityFee(): Promise<TransactionInstruction> {
    try {
      const recentFees = await this.connection.getRecentPrioritizationFees();

      if (recentFees.length === 0) {
        return ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: 5000,
        });
      }

      const sortedFees = recentFees
        .map((x) => x.prioritizationFee)
        .sort((a, b) => a - b);

      const medianFee = sortedFees[Math.floor(sortedFees.length / 2)];

      const finalFee = Math.min(Math.max(medianFee, 5000), 100000);

      return ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: finalFee,
      });
    } catch (error) {
      return ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 });
    }
  }

  async getMeteoraCandidates(
    amount: number,
    inputMint: string,
    outputMint: string
  ): Promise<RouteQuote[]> {
    try {
      const pools = await DLMM.getLbPairs(this.connection, {
        cluster: "devnet",
        params: { limit: 50 },
      } as any);

      const validPools = pools.filter((p: any) => {
        if (!p.account) return false;
        const tX = p.account.tokenXMint.toString();
        const tY = p.account.tokenYMint.toString();
        return (
          (tX === inputMint && tY === outputMint) ||
          (tX === outputMint && tY === inputMint)
        );
      });

      const candidates: RouteQuote[] = [];
      for (const pool of validPools.slice(0, 3)) {
        try {
          const dlmm = await DLMM.create(
            this.connection,
            new PublicKey(pool.publicKey),
            { cluster: "devnet" }
          );
          const binArrays = await dlmm.getBinArrayForSwap(false, 20);
          const inAmountBN = new BN(Math.floor(amount * 1_000_000_000));

          const quote = await dlmm.swapQuote(
            inAmountBN,
            false,
            new BN(10_000_000),
            binArrays
          );

          candidates.push({
            dex: "meteora",
            price: Number(quote.outAmount) / 1_000_000_000,
            outAmount: quote.outAmount,
            data: {
              poolAddress: pool.publicKey,
              quote,
              inAmountBN,
              inputMint,
              outputMint,
            },
          });
        } catch (e) {
          continue;
        }
      }
      return candidates;
    } catch (e) {
      return [];
    }
  }

  async getRaydiumCandidates(
    amount: number,
    inputMint: string,
    outputMint: string
  ): Promise<RouteQuote[]> {
    try {
      await this.initRaydium();

      const accounts = await this.connection.getProgramAccounts(
        RAYDIUM_PROGRAM_ID,
        { filters: [{ dataSize: 752 }] }
      );

      const matches = [];
      for (const acc of accounts) {
        const data = acc.account.data;
        const mintA = new PublicKey(data.subarray(400, 432)).toBase58();
        const mintB = new PublicKey(data.subarray(432, 464)).toBase58();

        if (
          (mintA === inputMint && mintB === outputMint) ||
          (mintA === outputMint && mintB === inputMint)
        ) {
          matches.push({ id: acc.pubkey.toBase58(), mintA, mintB });
        }
      }

      const candidates: RouteQuote[] = [];
      for (const poolData of matches) {
        try {
          const poolInfo = await this.raydium!.liquidity.getRpcPoolInfo(
            poolData.id
          );
          const amountIn = new BN(Math.floor(amount * 1_000_000_000));
          const poolKeys: any = {
            ...poolInfo,
            id: new PublicKey(poolData.id),
            programId: RAYDIUM_PROGRAM_ID,
            baseMint: new PublicKey(poolData.mintA),
            quoteMint: new PublicKey(poolData.mintB),
          };

          const { amountOut } = await this.raydium!.liquidity.computeAmountOut({
            poolInfo: poolKeys,
            amountIn,
            mintIn: new PublicKey(inputMint),
            mintOut: new PublicKey(outputMint),
            slippage: 0.1,
          });

          candidates.push({
            dex: "raydium",
            price: Number(amountOut) / 1_000_000_000,
            outAmount: amountOut,
            data: {
              pool: poolKeys,
              amountIn,
              minAmountOut: new BN(0),
              inputMint,
            },
          });
        } catch (e) {
          continue;
        }
      }
      return candidates;
    } catch (e) {
      return [];
    }
  }

  async executeMockSwap(
    amount: number
  ): Promise<{ txHash: string; price: number; dex: string }> {
    const quote = this.virtualPool.getQuote(amount);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const mockTx = `mock_tx_${randomUUID().replace(/-/g, "")}`.substring(0, 64);
    return { txHash: mockTx, price: quote.price, dex: "mock-engine" };
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    return Promise.race([
      promise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
    ]);
  }

  async executeSwap(
    orderId: string,
    amount: number,
    inputMint: string,
    outputMint: string
  ): Promise<{ txHash: string; price: number; dex: string }> {
    console.log(`\n🔍 [Router] Scanning liquidity for Order ${orderId}...`);

    try {
      const [meteora, raydium] = await Promise.all([
        this.withTimeout(
          this.getMeteoraCandidates(amount, inputMint, outputMint),
          5000
        ),
        this.withTimeout(
          this.getRaydiumCandidates(amount, inputMint, outputMint),
          5000
        ),
      ]);

      const safeMeteora = meteora || [];
      const safeRaydium = raydium || [];

      const allRoutes = [...safeMeteora, ...safeRaydium].sort((a, b) =>
        b.outAmount.sub(a.outAmount).toNumber()
      );

      console.log(`   > Found ${safeMeteora.length} Meteora pools`);
      console.log(`   > Found ${safeRaydium.length} Raydium pools`);

      for (const route of allRoutes) {
        try {
          console.log(`👉 Trying ${route.dex.toUpperCase()}...`);
          if (route.dex === "meteora") return await this.executeMeteora(route);
          if (route.dex === "raydium") return await this.executeRaydium(route);
        } catch (e: any) {
          console.warn(`⚠️ Route failed: ${e.message}... Next.`);
        }
      }
    } catch (e) {
      console.log("Real execution logic failed, falling back.");
    }

    console.log(
      "All Real DEXs failed or Congested. Switching to Mock Execution."
    );
    return await this.executeMockSwap(amount);
  }

  private async executeMeteora(
    route: RouteQuote
  ): Promise<{ txHash: string; price: number; dex: string }> {
    const { poolAddress, inAmountBN, inputMint, outputMint } = route.data;
    const dlmm = await DLMM.create(
      this.connection,
      new PublicKey(poolAddress),
      { cluster: "devnet" }
    );

    await dlmm.refetchStates();
    const binArrays = await dlmm.getBinArrayForSwap(false, 20);
    const freshQuote = await dlmm.swapQuote(
      inAmountBN,
      false,
      new BN(10_000_000),
      binArrays
    );

    const swapTx = await dlmm.swap({
      inToken: new PublicKey(inputMint),
      outToken: new PublicKey(outputMint),
      inAmount: inAmountBN,
      minOutAmount: new BN(0),
      lbPair: dlmm.pubkey,
      user: this.wallet.publicKey,
      binArraysPubkey: freshQuote.binArraysPubkey,
    });

    const transaction = new Transaction();

    const priorityIx = await this.getDynamicPriorityFee();
    transaction.add(priorityIx);

    transaction.add(...swapTx.instructions);

    const latestBlockhash = await this.connection.getLatestBlockhash();
    transaction.recentBlockhash = latestBlockhash.blockhash;
    transaction.feePayer = this.wallet.publicKey;

    const signature = await this.connection.sendTransaction(
      transaction,
      [this.wallet],
      { skipPreflight: false }
    );
    await this.connection.confirmTransaction(
      { signature, ...latestBlockhash },
      "confirmed"
    );

    return { txHash: signature, price: route.price, dex: "meteora" };
  }

  private async executeRaydium(
    route: RouteQuote
  ): Promise<{ txHash: string; price: number; dex: string }> {
    if (!this.raydium) await this.initRaydium();
    const { pool, poolInfo, amountIn, minAmountOut, inputMint } = route.data;

    const { execute } = await this.raydium!.liquidity.swap({
      poolInfo: { ...pool, ...poolInfo },
      amountIn: amountIn,
      amountOut: minAmountOut,
      fixedSide: "in",
      inputMint: inputMint,
      txVersion: 0,
    });

    const result = await execute({ sendAndConfirm: true });
    return { txHash: result.txId, price: route.price, dex: "raydium" };
  }
}
