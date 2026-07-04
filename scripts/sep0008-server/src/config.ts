/**
 * Environment-variable parsing. Reads from process.env (with optional
 * .env file loaded by `dotenv` in `index.ts`) and validates required
 * vars. Throws on first missing var so the server fails fast at
 * startup.
 *
 * See docs/sep0008-hook.md §8 for the full list and semantics.
 */

import { Keypair, Networks } from "@stellar/stellar-sdk";

export interface Config {
  port: number;
  logLevel: "debug" | "info" | "warn" | "error";
  rateLimitPerMin: number;
  apiKey: string;
  mockMode: boolean;
  stellar: {
    network: "testnet" | "futurenet" | "mainnet";
    rpcUrl: string;
    networkPassphrase: string;
    hookServerKeypair: Keypair;
  };
  contracts: {
    emtTokenId: string;
    complianceHookId: string;
  };
  providers: {
    kyc?: ProviderConfig;
    sanctions?: ProviderConfig;
    travelRule?: ProviderConfig;
  };
}

export interface ProviderConfig {
  url: string;
  apiKey: string;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(`missing required env var: ${name}`);
  }
  return v;
}

function optionalEnv(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

function resolveNetworkPassphrase(network: string): string {
  switch (network) {
    case "testnet":
      return Networks.TESTNET;
    case "futurenet":
      return Networks.FUTURENET;
    case "mainnet":
      return Networks.PUBLIC;
    default:
      throw new Error(`unknown STELLAR_NETWORK: ${network}`);
  }
}

export function loadConfig(): Config {
  const network = requireEnv("STELLAR_NETWORK") as
    | "testnet"
    | "futurenet"
    | "mainnet";
  const mockMode = (optionalEnv("MOCK_MODE") ?? "1") === "1";

  const providerConfig = (name: "KYC" | "SANCTIONS" | "TRAVEL_RULE"): ProviderConfig | undefined => {
    const url = optionalEnv(`${name}_PROVIDER_URL`);
    const key = optionalEnv(`${name}_PROVIDER_API_KEY`);
    if (!url) return undefined;
    return { url, apiKey: key ?? "" };
  };

  return {
    port: Number(optionalEnv("PORT") ?? 3000),
    logLevel: (optionalEnv("LOG_LEVEL") ?? "info") as Config["logLevel"],
    rateLimitPerMin: Number(optionalEnv("RATE_LIMIT_PER_MIN") ?? 60),
    apiKey: requireEnv("API_KEY"),
    mockMode,
    stellar: {
      network,
      rpcUrl: requireEnv("STELLAR_RPC_URL"),
      networkPassphrase:
        optionalEnv("STELLAR_NETWORK_PASSPHRASE") ??
        resolveNetworkPassphrase(network),
      hookServerKeypair: Keypair.fromSecret(requireEnv("HOOK_SERVER_SECRET_KEY")),
    },
    contracts: {
      emtTokenId: requireEnv("EMT_CONTRACT_ID"),
      complianceHookId: requireEnv("COMPLIANCE_HOOK_CONTRACT_ID"),
    },
    providers: {
      kyc: providerConfig("KYC"),
      sanctions: providerConfig("SANCTIONS"),
      travelRule: providerConfig("TRAVEL_RULE"),
    },
  };
}
