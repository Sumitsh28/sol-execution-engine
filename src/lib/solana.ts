import {
  Connection,
  Keypair,
  PublicKey,
  ComputeBudgetProgram,
  TransactionInstruction,
  Transaction,
} from "@solana/web3.js";
import DLMM from "@meteora-ag/dlmm";
import { BN } from "bn.js";
import dotenv from "dotenv";
import bs58 from "bs58";

dotenv.config();

const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

export class DexHandler {
  connection: Connection;
  wallet: Keypair;

  constructor() {
    this.connection = new Connection(
      process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
      "confirmed"
    );

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
      console.error("Invalid Private Key format in .env");
      process.exit(1);
    }
  }

  async getPriorityFeeInstruction(): Promise<TransactionInstruction> {
    return ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: 100000,
    });
  }

  async getMeteoraQuote(amount: number) {
    try {
      console.log("Scanning Meteora Pools...");
      const pools = await DLMM.getLbPairs(this.connection, {
        cluster: "devnet",
      });

      const validPools = pools.filter((pool: any) => {
        const p = pool as any;
        if (!p.account) return false;

        const tX = p.account.tokenXMint.toString();
        const tY = p.account.tokenYMint.toString();
        const sol = SOL_MINT.toBase58();
        const usdc = USDC_MINT.toBase58();

        return (tX === sol && tY === usdc) || (tX === usdc && tY === sol);
      });

      console.log(
        `Found ${validPools.length} potential SOL-USDC pools. Checking liquidity...`
      );

      for (const pool of validPools) {
        try {
          const p = pool as any;
          const result = await this.getQuoteFromAddress(p.publicKey, amount);
          if (result) {
            console.log(
              `Found valid liquidity in pool: ${p.publicKey.toBase58()}`
            );
            return result;
          }
        } catch (err: any) {}
      }

      throw new Error("All SOL-USDC pools are empty on Devnet right now.");
    } catch (e: any) {
      console.log("Meteora Quote Failed:", e.message);
      return null;
    }
  }

  async getQuoteFromAddress(poolAddress: PublicKey, amount: number) {
    const dlmm = await DLMM.create(this.connection, poolAddress, {
      cluster: "devnet",
    });

    const swapYtoX = false;
    const binArrays = await dlmm.getBinArrayForSwap(swapYtoX);

    const inAmount = new BN(Math.floor(amount * 1_000_000_000));

    const quote = await dlmm.swapQuote(
      inAmount,
      swapYtoX,
      new BN(10_000_000),
      binArrays
    );

    return {
      dex: "meteora",
      price: Number(quote.outAmount) / 1_000_000,
      pool: dlmm,
      quoteData: quote,
      binArrays,
    };
  }

  async executeSwap(
    orderId: string,
    amount: number
  ): Promise<{ txHash: string; price: number }> {
    const bestRoute = await this.getMeteoraQuote(amount);

    if (!bestRoute) {
      throw new Error("No liquidity pools found on Devnet for SOL-USDC");
    }

    console.log(`[Worker] Executing on ${bestRoute.dex} for Order ${orderId}`);

    const swapTx = await bestRoute.pool.swap({
      inToken: SOL_MINT,
      outToken: USDC_MINT,
      inAmount: new BN(Math.floor(amount * 1_000_000_000)),
      minOutAmount: new BN(0),
      lbPair: bestRoute.pool.pubkey,
      user: this.wallet.publicKey,
      binArraysPubkey: bestRoute.quoteData.binArraysPubkey,
    });

    const priorityIx = await this.getPriorityFeeInstruction();
    swapTx.instructions.unshift(priorityIx);

    const latestBlockhash = await this.connection.getLatestBlockhash();
    swapTx.recentBlockhash = latestBlockhash.blockhash;
    swapTx.feePayer = this.wallet.publicKey;

    const txHash = await this.connection.sendTransaction(
      swapTx,
      [this.wallet],
      {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      }
    );

    console.log(
      `Transaction Sent: https://explorer.solana.com/tx/${txHash}?cluster=devnet`
    );

    await this.connection.confirmTransaction(
      {
        signature: txHash,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      "confirmed"
    );

    return { txHash, price: bestRoute.price };
  }
}
