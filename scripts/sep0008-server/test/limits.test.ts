/**
 * Unit tests for the limits providers (MockLimitsProvider +
 * EmtTokenLimitsProvider).
 *
 * Coverage:
 *   - MockLimitsProvider state semantics: forceExceed / per-addr
 *     overrides / currentOutflow math / 0=unlimited sentinel
 *   - EmtTokenLimitsProvider chain-read wiring: contract method
 *     dispatch + wouldExceed decision logic, mocking the Soroban
 *     Server similar to sdk/__tests__/EmtClient.test.ts
 */

import { Keypair } from "@stellar/stellar-sdk";
import * as stellarSdk from "@stellar/stellar-sdk";
import {
  MockLimitsProvider,
  EmtTokenLimitsProvider,
} from "../src/compliance/limits";

jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    scValToNative: jest.fn(),
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: jest.fn(),
    },
  };
});

const mockedSdk = stellarSdk as jest.Mocked<typeof stellarSdk>;
const ServerMock = mockedSdk.SorobanRpc.Server as unknown as jest.Mock;
const scValToNativeMock = mockedSdk.scValToNative as unknown as jest.Mock;

interface MockServer {
  simulateTransaction: jest.Mock;
}

function lastServer(): MockServer {
  const results = ServerMock.mock.results;
  if (results.length === 0) throw new Error("Server was not constructed");
  return results[results.length - 1].value as MockServer;
}

beforeEach(() => {
  ServerMock.mockReset();
  scValToNativeMock.mockReset();
  ServerMock.mockImplementation(() => ({
    simulateTransaction: jest
      .fn()
      .mockResolvedValue({ result: { retval: {} } }),
  }));
});

// ── MockLimitsProvider ────────────────────────────────────────────────────────

describe("MockLimitsProvider", () => {
  it("defaults to a 100_000_000n per-tx cap", async () => {
    const p = new MockLimitsProvider();
    expect(await p.wouldExceed("G" + "A".repeat(55), 100_000_001n)).toBe(true);
    expect(await p.wouldExceed("G" + "A".repeat(55), 100_000_000n)).toBe(false);
  });

  it("forceExceed short-circuits any amount to true", async () => {
    const p = new MockLimitsProvider({ forceExceed: true });
    expect(await p.wouldExceed("G" + "A".repeat(55), 1n)).toBe(true);
    expect(await p.wouldExceed("G" + "B".repeat(55), 0n)).toBe(true);
  });

  it("treats a 0n limit as unlimited (matches on-chain sentinel)", async () => {
    const p = new MockLimitsProvider({
      perTxCap: 0n,
      currentOutflow: new Map([["G" + "A".repeat(55), 999_999_999n]]),
    });
    expect(await p.wouldExceed("G" + "A".repeat(55), 9_999_999n)).toBe(false);
  });

  it("treats a per-address 0n override as unlimited for that address only", async () => {
    const p = new MockLimitsProvider({
      perTxCap: 100_000_000n,
      perAddressLimit: new Map([["G" + "C".repeat(55), 0n]]),
      currentOutflow: new Map([["G" + "C".repeat(55), 999_999_999n]]),
    });
    // Unlimited override wins:
    expect(await p.wouldExceed("G" + "C".repeat(55), 1n)).toBe(false);
    // Default cap applies to anyone else:
    expect(await p.wouldExceed("G" + "D".repeat(55), 100_000_001n)).toBe(true);
  });

  it("compares current + additional against effective limit (per-addr override wins)", async () => {
    const p = new MockLimitsProvider({
      perTxCap: 10_000_000_000n, // huge default to prove override wins
      currentOutflow: new Map([["G" + "E".repeat(55), 50_000_000n]]),
      perAddressLimit: new Map([["G" + "E".repeat(55), 100_000_000n]]),
    });
    // 50M + 49M = 99M → under
    expect(await p.wouldExceed("G" + "E".repeat(55), 49_999_999n)).toBe(false);
    // 50M + 51M = 101M → over
    expect(await p.wouldExceed("G" + "E".repeat(55), 51_000_000n)).toBe(true);
  });

  it("treats unknown addresses as having zero current outflow", async () => {
    const p = new MockLimitsProvider({ perTxCap: 10n });
    expect(await p.wouldExceed("G" + "F".repeat(55), 11n)).toBe(true);
    expect(await p.wouldExceed("G" + "F".repeat(55), 10n)).toBe(false);
  });
});

// ── EmtTokenLimitsProvider ────────────────────────────────────────────────────

describe("EmtTokenLimitsProvider", () => {
  const rpcUrl = "https://soroban-testnet.example";
  const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
  const networkPassphrase = "Test SDF Network ; September 2015";

  function buildProvider() {
    return new EmtTokenLimitsProvider({
      rpcUrl,
      contractId,
      networkPassphrase,
    });
  }

  const addr = () => Keypair.random().publicKey();

  it("calls get_velocity_limit(addr) before any other view method on first check", async () => {
    const contractCallSpy = jest.spyOn(
      stellarSdk.Contract.prototype as unknown as { call: jest.Mock },
      "call"
    );
    scValToNativeMock.mockReturnValue(0n); // unlimited
    await buildProvider().wouldExceed(addr(), 0n);
    const limitCall = contractCallSpy.mock.calls.find(
      (c) => c[0] === "get_velocity_limit"
    );
    expect(limitCall).toBeDefined();
    // First call only — return is 0n so we exit early without
    // calling get_outflow_today.
    expect(contractCallSpy.mock.calls.length).toBe(1);
  });

  it("returns false (unlimited) when get_velocity_limit returns 0n", async () => {
    scValToNativeMock.mockReturnValue(0n);
    expect(await buildProvider().wouldExceed(addr(), 1_000_000_000n)).toBe(
      false
    );
    // No outflow query needed for unlimited.
    const server = lastServer();
    expect(server.simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it("also queries get_outflow_today when limit > 0; returns false when projected is at or under", async () => {
    const contractCallSpy = jest.spyOn(
      stellarSdk.Contract.prototype as unknown as { call: jest.Mock },
      "call"
    );
    // 1st simulate → get_velocity_limit returns 100M
    // 2nd simulate → get_outflow_today returns 30M
    scValToNativeMock.mockReturnValueOnce(100_000_000n).mockReturnValueOnce(30_000_000n);
    expect(await buildProvider().wouldExceed(addr(), 70_000_000n)).toBe(false); // 30 + 70 = 100, not strictly over
    const calls = contractCallSpy.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(["get_velocity_limit", "get_outflow_today"]);
  });

  it("returns true when current + additional exceeds the limit", async () => {
    scValToNativeMock.mockReturnValueOnce(100_000_000n).mockReturnValueOnce(50_000_000n);
    expect(await buildProvider().wouldExceed(addr(), 50_000_001n)).toBe(true); // 50M + 50,000,001 = 100,000,001 > 100M
  });

  it("treats simulation errors as throws", async () => {
    const provider = buildProvider();
    lastServer().simulateTransaction.mockResolvedValue({ error: "boom" });
    await expect(provider.wouldExceed(addr(), 0n)).rejects.toThrow(
      /get_velocity_limit simulation failed/
    );
  });

  it("treats missing retval as throws", async () => {
    const provider = buildProvider();
    lastServer().simulateTransaction.mockResolvedValue({});
    await expect(provider.wouldExceed(addr(), 0n)).rejects.toThrow(
      /returned no value/
    );
  });

  it("rejects empty rpcUrl", () => {
    expect(() => new EmtTokenLimitsProvider({
      rpcUrl: "",
      contractId,
      networkPassphrase,
    })).toThrow(/rpcUrl/);
  });

  it("rejects empty contractId", () => {
    expect(() => new EmtTokenLimitsProvider({
      rpcUrl,
      contractId: "",
      networkPassphrase,
    })).toThrow(/contractId/);
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});
