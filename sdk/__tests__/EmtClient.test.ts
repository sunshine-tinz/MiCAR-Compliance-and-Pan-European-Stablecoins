/**
 * Unit tests for the MiCAR EMT client (`sdk/src/EmtClient.ts`).
 *
 * Strategy:
 *  - Mock `@stellar/stellar-sdk` so that the network-touching pieces
 *    (`SorobanRpc.Server`, `scValToNative`) are replaceable, while keeping
 *    the encoder + value types (`Contract`, `nativeToScVal`, `Address`,
 *    `Keypair`, `TransactionBuilder`, `Account`, `xdr`, etc.) real.
 *  - Spy on `Contract.prototype.call` to verify the dispatched method
 *    name and argument count without bypassing the SDK encoder.
 *  - Drive the test envs through three return-coercion modes
 *    (string / number / bigint / boolean / null) and three failure modes
 *    (SimulationError response, no-retval response, RPC transport throw)
 *    so every `EmtClientError` path is covered.
 */

import { Keypair } from "@stellar/stellar-sdk";
import * as stellarSdk from "@stellar/stellar-sdk";

import { EmtClient, EmtClientConfig, EmtClientError } from "../src/EmtClient";

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
  getAccount: jest.Mock;
  sendTransaction: jest.Mock;
  getTransaction: jest.Mock;
}

function makeServer(): MockServer {
  return {
    simulateTransaction: jest.fn(),
    getAccount: jest.fn(),
    sendTransaction: jest.fn(),
    getTransaction: jest.fn(),
  };
}

function lastServer(): MockServer {
  const results = ServerMock.mock.results;
  if (results.length === 0) throw new Error("Server was not constructed");
  return results[results.length - 1].value as MockServer;
}

const VALID: EmtClientConfig = {
  contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
  networkPassphrase: "Test SDF Network ; September 2015",
  rpcUrl: "https://soroban-testnet.example",
};

function buildClient(overrides: Partial<EmtClientConfig> = {}): EmtClient {
  return new EmtClient({ ...VALID, ...overrides });
}

// Keypair.random() always emits a valid base32 G-address so we don't have
// to hard-code long ed25519 strings.
const alice = (): string => Keypair.random().publicKey();
const bob = (): string => Keypair.random().publicKey();

beforeEach(() => {
  ServerMock.mockReset();
  scValToNativeMock.mockReset();
  // Default successful simulation. Tests that need a different shape
  // (errors, missing retval) override `lastServer().simulateTransaction`
  // AFTER constructing a client. Without a working default, every read
  // helper would crash on `SorobanRpc.Api.isSimulationError(undefined)`.
  ServerMock.mockImplementation(
    (): MockServer => ({
      simulateTransaction: jest
        .fn()
        .mockResolvedValue({ result: { retval: {} } }),
      getAccount: jest.fn(),
      sendTransaction: jest.fn(),
      getTransaction: jest.fn(),
    })
  );
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── Constructor validation ────────────────────────────────────────────────────

describe("EmtClient constructor", () => {
  it("throws EmtClientError when contractId is empty", () => {
    expect(() => buildClient({ contractId: "" })).toThrow(EmtClientError);
    expect(() => buildClient({ contractId: "" })).toThrow(/contractId/);
  });

  it("throws EmtClientError when networkPassphrase is empty", () => {
    expect(() => buildClient({ networkPassphrase: "" })).toThrow(
      EmtClientError
    );
    expect(() => buildClient({ networkPassphrase: "" })).toThrow(
      /networkPassphrase/
    );
  });

  it("throws EmtClientError when rpcUrl is empty", () => {
    expect(() => buildClient({ rpcUrl: "" })).toThrow(EmtClientError);
    expect(() => buildClient({ rpcUrl: "" })).toThrow(/rpcUrl/);
  });

  it("uses the supplied baseFee as a string", () => {
    const client = buildClient({ baseFee: 250 });
    expect((client as unknown as { baseFee: string }).baseFee).toBe("250");
  });

  it("falls back to SDK default baseFee when omitted", () => {
    const client = buildClient();
    expect((client as unknown as { baseFee: string }).baseFee).toBe(
      String(mockedSdk.BASE_FEE)
    );
  });

  it("falls back to SDK default when baseFee is NaN", () => {
    const client = buildClient({ baseFee: Number.NaN });
    expect((client as unknown as { baseFee: string }).baseFee).toBe(
      String(mockedSdk.BASE_FEE)
    );
  });

  it("constructs the RPC Server with allowHttp=true for http URLs", () => {
    buildClient({ rpcUrl: "http://localhost:8000" });
    expect(ServerMock).toHaveBeenCalledTimes(1);
    expect(ServerMock).toHaveBeenCalledWith(
      "http://localhost:8000",
      expect.objectContaining({ allowHttp: true })
    );
  });

  it("constructs the RPC Server with allowHttp=false for https URLs", () => {
    buildClient({ rpcUrl: "https://soroban-testnet.example" });
    expect(ServerMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({ allowHttp: false })
    );
  });
});

// ── Read methods: contract dispatch (method + arg count) ──────────────────────

describe("EmtClient read methods — dispatch", () => {
  let callSpy: jest.SpyInstance;

  beforeEach(() => {
    scValToNativeMock.mockReturnValue(0n);
    callSpy = jest.spyOn(
      stellarSdk.Contract.prototype as unknown as { call: jest.Mock },
      "call"
    );
  });

  it("getName calls contract.call('name')", async () => {
    await buildClient().getName();
    expect(callSpy).toHaveBeenCalledWith("name");
  });

  it("getSymbol calls contract.call('symbol')", async () => {
    await buildClient().getSymbol();
    expect(callSpy).toHaveBeenCalledWith("symbol");
  });

  it("getDecimals calls contract.call('decimals')", async () => {
    await buildClient().getDecimals();
    expect(callSpy).toHaveBeenCalledWith("decimals");
  });

  it("getTotalSupply calls contract.call('total_supply')", async () => {
    await buildClient().getTotalSupply();
    expect(callSpy).toHaveBeenCalledWith("total_supply");
  });

  it("isPaused calls contract.call('is_paused')", async () => {
    await buildClient().isPaused();
    expect(callSpy).toHaveBeenCalledWith("is_paused");
  });

  it("getReserveAttestation calls contract.call('reserve_attestation')", async () => {
    await buildClient().getReserveAttestation();
    expect(callSpy).toHaveBeenCalledWith("reserve_attestation");
  });

  it("getPendingAdmin calls contract.call('pending_admin')", async () => {
    await buildClient().getPendingAdmin();
    expect(callSpy).toHaveBeenCalledWith("pending_admin");
  });

  it("getBalance calls contract.call('balance', address) with one arg", async () => {
    await buildClient().getBalance(alice());
    const found = callSpy.mock.calls.find((c) => c[0] === "balance");
    expect(found).toBeDefined();
    expect(found!.length).toBe(2);
    expect(found![1]).toEqual(expect.any(Object));
  });

  it("isBlocklisted calls contract.call('is_blocklisted', address)", async () => {
    await buildClient().isBlocklisted(alice());
    const found = callSpy.mock.calls.find((c) => c[0] === "is_blocklisted");
    expect(found).toBeDefined();
    expect(found!.length).toBe(2);
  });

  it("getAllowance calls contract.call('allowance', owner, spender)", async () => {
    await buildClient().getAllowance(alice(), bob());
    const found = callSpy.mock.calls.find((c) => c[0] === "allowance");
    expect(found).toBeDefined();
    expect(found!.length).toBe(3);
  });

  it("getVelocityLimit calls contract.call('get_velocity_limit', address)", async () => {
    await buildClient().getVelocityLimit(alice());
    const found = callSpy.mock.calls.find(
      (c) => c[0] === "get_velocity_limit"
    );
    expect(found).toBeDefined();
    expect(found!.length).toBe(2);
  });

  it("getOutflowToday calls contract.call('get_outflow_today', address)", async () => {
    await buildClient().getOutflowToday(alice());
    const found = callSpy.mock.calls.find(
      (c) => c[0] === "get_outflow_today"
    );
    expect(found).toBeDefined();
    expect(found!.length).toBe(2);
  });
});

// ── Read methods: return-value coercion ───────────────────────────────────────

describe("EmtClient read methods — return coercion", () => {
  it("getName returns the string from retval", async () => {
    scValToNativeMock.mockReturnValue("Euro EMT");
    expect(await buildClient().getName()).toBe("Euro EMT");
  });

  it("getSymbol returns the string from retval", async () => {
    scValToNativeMock.mockReturnValue("EUREMT");
    expect(await buildClient().getSymbol()).toBe("EUREMT");
  });

  it("getDecimals coerces retval to a number", async () => {
    scValToNativeMock.mockReturnValue(7);
    expect(await buildClient().getDecimals()).toBe(7);
  });

  it("getBalance coerces a numeric retval to bigint", async () => {
    scValToNativeMock.mockReturnValue(100_000_000);
    expect(await buildClient().getBalance(alice())).toBe(100_000_000n);
  });

  it("getTotalSupply passes a bigint retval through", async () => {
    scValToNativeMock.mockReturnValue(500_000_000n);
    expect(await buildClient().getTotalSupply()).toBe(500_000_000n);
  });

  it("getTotalSupply coerces numeric retval to bigint", async () => {
    scValToNativeMock.mockReturnValue(42);
    expect(await buildClient().getTotalSupply()).toBe(42n);
  });

  it("getAllowance coerces numeric retval to bigint", async () => {
    scValToNativeMock.mockReturnValue(42);
    expect(await buildClient().getAllowance(alice(), bob())).toBe(42n);
  });

  it("isPaused applies Boolean() to the retval", async () => {
    scValToNativeMock.mockReturnValue(true);
    expect(await buildClient().isPaused()).toBe(true);

    scValToNativeMock.mockReturnValue(false);
    expect(await buildClient().isPaused()).toBe(false);

    // Non-boolean truthy values coerce to true.
    scValToNativeMock.mockReturnValue({});
    expect(await buildClient().isPaused()).toBe(true);

    // Falsy values (including undefined) coerce to false.
    scValToNativeMock.mockReturnValue(undefined);
    expect(await buildClient().isPaused()).toBe(false);
  });

  it("isBlocklisted applies Boolean() to the retval", async () => {
    scValToNativeMock.mockReturnValue(true);
    expect(await buildClient().isBlocklisted(alice())).toBe(true);

    scValToNativeMock.mockReturnValue(undefined);
    expect(await buildClient().isBlocklisted(alice())).toBe(false);
  });

  it("getReserveAttestation returns null when retval decodes to null", async () => {
    scValToNativeMock.mockReturnValue(null);
    expect(await buildClient().getReserveAttestation()).toBeNull();
  });

  it("getReserveAttestation returns the string when retval is a string", async () => {
    scValToNativeMock.mockReturnValue("QmYwAP");
    expect(await buildClient().getReserveAttestation()).toBe("QmYwAP");
  });

  it("getPendingAdmin returns null when retval decodes to null", async () => {
    scValToNativeMock.mockReturnValue(null);
    expect(await buildClient().getPendingAdmin()).toBeNull();
  });

  it("getPendingAdmin returns the string when retval is a string", async () => {
    const addr = alice();
    scValToNativeMock.mockReturnValue(addr);
    expect(await buildClient().getPendingAdmin()).toBe(addr);
  });

  it("getVelocityLimit coerces numeric retval to bigint", async () => {
    scValToNativeMock.mockReturnValue(100_000_000);
    expect(await buildClient().getVelocityLimit(alice())).toBe(100_000_000n);
  });

  it("getOutflowToday passes a bigint retval through", async () => {
    scValToNativeMock.mockReturnValue(50_000_000n);
    expect(await buildClient().getOutflowToday(alice())).toBe(50_000_000n);
  });
});

// ── EmtClientError class ──────────────────────────────────────────────────────

describe("EmtClientError", () => {
  it("sets name to 'EmtClientError'", () => {
    const err = new EmtClientError("boom");
    expect(err instanceof Error).toBe(true);
    expect(err.name).toBe("EmtClientError");
    expect(err.message).toBe("boom");
  });

  it("omits cause when none supplied", () => {
    const err = new EmtClientError("boom");
    expect(err.cause).toBeUndefined();
  });

  it("preserves the supplied cause", () => {
    const cause = new Error("inner");
    const err = new EmtClientError("outer", cause);
    expect(err.cause).toBe(cause);
  });
});

// ── Read-method error wrapping ────────────────────────────────────────────────

describe("EmtClient read methods — error wrapping", () => {
  let client: EmtClient;
  let server: MockServer;

  beforeEach(() => {
    // Build the client up-front so the mock exists before tests poke
    // `server.simulateTransaction`. Reuse the same client across the
    // overrides so we exercise the actual builder.
    client = buildClient();
    server = lastServer();
  });

  it("wraps SimulationError responses in EmtClientError", async () => {
    server.simulateTransaction.mockResolvedValue({
      error: "Transaction failed",
    });
    await expect(client.getTotalSupply()).rejects.toThrow(EmtClientError);
    await expect(client.getTotalSupply()).rejects.toThrow(
      /view call "total_supply" failed/
    );
  });

  it("preserves the simulation-inner error via .cause", async () => {
    server.simulateTransaction.mockResolvedValue({ error: "Boom" });
    try {
      await client.getName();
      throw new Error("expected reject");
    } catch (err) {
      expect(err).toBeInstanceOf(EmtClientError);
      expect((err as EmtClientError).cause).toBeInstanceOf(Error);
      expect(((err as EmtClientError).cause as Error).message).toMatch(
        /Simulation failed/
      );
    }
  });

  it("wraps 'no return value' responses in EmtClientError", async () => {
    server.simulateTransaction.mockResolvedValue({});
    await expect(client.getName()).rejects.toThrow(EmtClientError);
    await expect(client.getName()).rejects.toThrow(/no return value/i);
  });

  it("wraps RPC transport errors in EmtClientError", async () => {
    server.simulateTransaction.mockRejectedValue(new Error("ECONNRESET"));
    await expect(client.getBalance(alice())).rejects.toThrow(EmtClientError);
    await expect(client.getBalance(alice())).rejects.toThrow(
      /view call "balance" failed/
    );
  });

  it("preserves the rejected promise's error as .cause", async () => {
    const original = new Error("specific failure");
    server.simulateTransaction.mockRejectedValue(original);
    try {
      await client.getSymbol();
      throw new Error("expected reject");
    } catch (err) {
      expect(err).toBeInstanceOf(EmtClientError);
      expect((err as EmtClientError).cause).toBe(original);
    }
  });

  it("uses the contract method name in the wrapped message", async () => {
    server.simulateTransaction.mockRejectedValue(new Error("boom"));
    await expect(client.isPaused()).rejects.toThrow(/is_paused/);
    await expect(client.getDecimals()).rejects.toThrow(/decimals/);
    await expect(client.isBlocklisted(alice())).rejects.toThrow(
      /is_blocklisted/
    );
    await expect(client.getReserveAttestation()).rejects.toThrow(
      /reserve_attestation/
    );
    await expect(client.getPendingAdmin()).rejects.toThrow(/pending_admin/);
  });
});
