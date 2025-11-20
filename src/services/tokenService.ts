import axios from "axios";
import { redisClient } from "../config/redis";

export class TokenService {
  private static CACHE_KEY = "jupiter-token-list";
  private static CACHE_TTL = 86400;

  private static FALLBACK_MAP: Record<string, string> = {
    SOL: "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  };

  static async getTokenMap() {
    const cached = await redisClient.get(this.CACHE_KEY);
    if (cached) {
      return JSON.parse(cached);
    }

    console.log("🔄 Fetching fresh token list from Jupiter...");
    try {
      const { data } = await axios.get("https://token.jup.ag/strict");

      const tokenMap = data.reduce((map: any, token: any) => {
        map[token.symbol.toUpperCase()] = token.address;
        return map;
      }, {});

      const finalMap = { ...tokenMap, ...this.FALLBACK_MAP };

      await redisClient.set(
        this.CACHE_KEY,
        JSON.stringify(finalMap),
        "EX",
        this.CACHE_TTL
      );
      return finalMap;
    } catch (error) {
      console.error("❌ Failed to fetch token list. Using Fallback.");
      return this.FALLBACK_MAP;
    }
  }

  static async getMint(symbol: string): Promise<string | null> {
    const map = await this.getTokenMap();
    return map[symbol.toUpperCase()] || null;
  }
}
