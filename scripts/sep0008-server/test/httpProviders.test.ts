/**
 * Integration test: HttpKycProvider + HttpSanctionsProvider driving
 * the /tx-approve handler against a real HTTP server mock.
 *
 * Strategy: spin up an `http.createServer` on a random port per test,
 * route by URL path (`/kyc/screen` and `/sanctions/screen`) so the
 * two providers can share a base URL, and return canned JSON
 * responses that exercise every documented decision path.
 *
 * Why a real http.createServer (vs. `nock` / module-level fetch mock):
 *   - exercises the actual TLS-less socket layer that production
 *     images will exercise
 *   - makes the test express failures loudly if the provider
 *     rewrites paths, headers, or auth unexpectedly
 *   - avoids the `nock` dependency footprint
 *
 * Test classes:
 *   1. **`mapKycResponse` / `mapSanctionsResponse`** — pure-function
 *      unit tests; no IO.
 *   2. **`HttpKycProvider` / `HttpSanctionsProvider` standalone** —
 *      exercise request shape, error mapping, transport failures
 *      (timeout, 5xx, malformed JSON) against a mock HTTP server.
 *   3. **`/tx-approve` integration** — drive the handler end to end
 *      and assert the response shape documented in
 *      docs/sep0008-hook.md §2.1.
 */

import http from "node:http";
import express from "express";
import request from "supertest";
import {
  Keypair,
  Networks,
  TransactionBuilder,
  Account,
  Asset,
  Operation,
} from "@stellar/stellar-sdk";
import {
  HttpKycProvider,
  mapKycResponse,
} from "../src/compliance/kyc";
import {
  HttpSanctionsProvider,
  mapSanctionsResponse,
  type SanctionsHit,
} from "../src/compliance/sanctions";
import { MockLimitsProvider } from "../src/compliance/limits";
import { MockTravelRuleProvider } from "../src/compliance/travelRule";
import { makeTxApproveHandler } from "../src/handlers/txApprove";
import { StellarSigner } from "../src/stellar/signer";

// Default 5s timeout in the providers is too slow for tests; truncate
// everywhere via the timeoutMs constructor arg.

// ── Mock HTTP server helpers ──────────────────────────────────────────────────

interface ReceivedRequest {
  path: string;
  method: string;
  body: string;
  authHeader: string | undefined;
  contentType: string | undefined;
}

interface JsonResponse {
  status: number;
  body: unknown;
}

interface RawResponse {
  status: number;
  contentType: string;
  body: string;
}

type HandlerReturn = JsonResponse | RawResponse;

interface MockServer {
  url: string;
  received: ReceivedRequest[];
  setHandler: (handler: (req: ReceivedRequest) => HandlerReturn) => void;
  /** Drop the connection mid-request to simulate an upstream outage. */
  nextRequestShouldHang: () => void;
  close: () => Promise<void>;
}

/**
 * Boots a single Node HTTP server on a random port per test. The test's
 * handler decides whether to return a `JsonResponse` (the usual case)
 * or a `RawResponse` (for malformed-body tests). All in-flight sockets
 * are tracked so `close()` can forcibly destroy any lingering
 * connections — necessary because the "hang" path never writes a
 * HTTP response and waiting for the client to abort+close TCP can
 * take longer than Jest's per-test timeout.
 */
async function startMockServer(): Promise<MockServer> {
  const received: ReceivedRequest[] = [];
  let handler: (req: ReceivedRequest) => HandlerReturn = () =>
    ({ status: 500, body: { error: "no handler set" } });
  let hangNext = false;
  const trackedSockets = new Set<import("node:net").Socket>();

  const server = http.createServer((req, res) => {
    trackedSockets.add(req.socket);
    req.socket.once("close", () => trackedSockets.delete(req.socket));

    if (hangNext) {
      hangNext = false;
      // Skip writing a response. The client will time out via
      // AbortController and eventually close its side of the TCP
      // socket, but the server-side half-open can linger. Mark
      // the socket for forced-destroy on `close()` so the test
      // shutdown hook always completes.
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      const entry: ReceivedRequest = {
        path: req.url ?? "/",
        method: req.method ?? "GET",
        body,
        authHeader: req.headers.authorization,
        contentType: req.headers["content-type"],
      };
      received.push(entry);
      try {
        const out = handler(entry);
        if ("contentType" in out) {
          res.statusCode = out.status;
          res.setHeader("content-type", out.contentType);
          res.end(out.body);
        } else {
          res.statusCode = out.status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(out.body));
        }
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}`,
    received,
    setHandler: (h) => {
      handler = h;
    },
    nextRequestShouldHang: () => {
      hangNext = true;
    },
    close: () => {
      // Force-destroy any sockets still in `trackedSockets` so
      // server.close() resolves promptly even when the "hang"
      // path left a connection half-open. Then closeAllConnections
      // (Node 18.2+) tells the server to drop in-flight sockets
      // immediately so server.close() doesn't stall. As a last
      // resort we cap the wait at 500ms so a hung mock with
      // sockets we somehow missed can't pin a Jest worker — but
      // we race the close callback vs. the timer and clear the
      // loser so we don't leak orphaned timers when the close
      // resolves promptly.
      for (const sock of trackedSockets) {
        sock.destroy();
      }
      trackedSockets.clear();
      const closer =
        typeof server.closeAllConnections === "function"
          ? server.closeAllConnections.bind(server)
          : () => {
              /* no-op on Node <18.2 */
            };
      closer();
      return new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve();
        };
        server.close(finish);
        timer = setTimeout(finish, 500);
      });
    },
  };
}

// ── XDR builders (mirror the helpers in txApprove.test.ts) ──────────────────

function buildXdr(source: string): string {
  const account = new Account(source, "0");
  const dest = Keypair.random().publicKey();
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: dest,
        asset: Asset.native(),
        amount: "1",
      })
    )
    .setTimeout(30)
    .build();
  return tx.toXDR();
}

function buildApp(
  kyc: HttpKycProvider,
  sanctions: HttpSanctionsProvider,
  timeoutMs?: number
) {
  const app = express();
  app.use(express.json());
  app.post(
    "/tx-approve",
    makeTxApproveHandler({
      kyc,
      sanctions,
      limits: new MockLimitsProvider(),
      travelRule: new MockTravelRuleProvider(),
      signer: new StellarSigner(Keypair.random()),
      networkPassphrase: Networks.TESTNET,
      approvalTtlLedgers: 17_280,
    })
  );
  // timeoutMs is unused here but kept to keep future hooks legible;
  // we tighten timeouts on the providers themselves below.
  void timeoutMs;
  return app;
}

// ── Pure-function unit tests for the response mappers ──────────────────────

describe("mapKycResponse / mapSanctionsResponse", () => {
  it("mapKycResponse: verified with explicit enhanced level", () => {
    expect(mapKycResponse({ status: "verified", level: "enhanced" })).toEqual({
      kind: "verified",
      level: "enhanced",
    });
  });

  it("mapKycResponse: verified defaults to basic when level missing", () => {
    expect(mapKycResponse({ status: "verified" })).toEqual({
      kind: "verified",
      level: "basic",
    });
  });

  it("mapKycResponse: pending requires action_url", () => {
    expect(() => mapKycResponse({ status: "pending" })).toThrow(/action_url/);
  });

  it("mapKycResponse: failed defaults reason when missing", () => {
    expect(mapKycResponse({ status: "failed" })).toEqual({
      kind: "failed",
      reason: "rejected by provider",
    });
  });

  it("mapKycResponse: unknown maps to unknown", () => {
    expect(mapKycResponse({ status: "unknown" })).toEqual({ kind: "unknown" });
  });

  it("mapKycResponse: garbage status throws malformed", () => {
    // Cast through `unknown` so we can pass a status literal that
    // isn't in `RawKycResponse["status"]` — the function should fail
    // closed rather than coerce.
    expect(() =>
      mapKycResponse({ status: "wibble" } as unknown as Parameters<typeof mapKycResponse>[0])
    ).toThrow(/unknown status/);
  });

  it("mapSanctionsResponse: hit=false returns null", () => {
    expect(mapSanctionsResponse({ hit: false })).toBeNull();
    // hit absent → also null (treat absence as no-match)
    expect(mapSanctionsResponse({})).toBeNull();
  });

  it("mapSanctionsResponse: hit=true with full fields returns SanctionsHit", () => {
    expect(
      mapSanctionsResponse({
        hit: true,
        list: "OFAC_SDN",
        matched_field: "name",
        matched_value: "Foo Bar",
      })
    ).toEqual({
      list: "OFAC_SDN",
      matched_field: "name",
      matched_value: "Foo Bar",
    });
  });

  it("mapSanctionsResponse: hit=true without field detail throws malformed", () => {
    expect(() => mapSanctionsResponse({ hit: true })).toThrow(
      /list \/ matched_field \/ matched_value/
    );
  });
});

// ── Standalone unit tests for the providers against a mock server ───────────

describe("HttpKycProvider (standalone)", () => {
  let server: MockServer;
  beforeEach(async () => {
    server = await startMockServer();
  });
  afterEach(async () => {
    await server.close();
  });

  const apiKey = "test-kyc-key";

  it("POSTs to {url}/kyc/screen with Bearer auth and {address} body", async () => {
    server.setHandler(() => ({
      status: 200,
      body: { status: "verified", level: "enhanced" },
    }));
    const provider = new HttpKycProvider({ url: server.url, apiKey });
    await provider.status("GABC").catch(() => undefined);
    const req = server.received[0];
    expect(req.path).toBe("/kyc/screen");
    expect(req.method).toBe("POST");
    expect(req.authHeader).toBe(`Bearer ${apiKey}`);
    expect(req.contentType).toMatch(/application\/json/);
    expect(JSON.parse(req.body)).toEqual({ address: "GABC" });
  });

  it("appends /kyc/screen to a base URL with an existing path component (e.g. /v1)", async () => {
    // Real vendors commonly expose a versioned path on the base URL
    // (e.g. `https://api.example.com/v1`). The provider must append
    // `/kyc/screen` after that prefix, not replace the prefix.
    server.setHandler(() => ({
      status: 200,
      body: { status: "verified", level: "basic" },
    }));
    const provider = new HttpKycProvider({
      url: `${server.url}/v1`,
      apiKey,
    });
    await provider.status("GABC").catch(() => undefined);
    expect(server.received[0].path).toBe("/v1/kyc/screen");
  });

  it("returns verified KycStatus on a 200 verified response", async () => {
    server.setHandler(() => ({
      status: 200,
      body: { status: "verified", level: "enhanced" },
    }));
    const provider = new HttpKycProvider({ url: server.url, apiKey });
    expect(await provider.status("GABC")).toEqual({
      kind: "verified",
      level: "enhanced",
    });
  });

  it("returns pending KycStatus on a 200 pending response with action_url", async () => {
    server.setHandler(() => ({
      status: 200,
      body: { status: "pending", action_url: "https://kyc.example.com/x" },
    }));
    const provider = new HttpKycProvider({ url: server.url, apiKey });
    expect(await provider.status("GABC")).toEqual({
      kind: "pending",
      action_url: "https://kyc.example.com/x",
    });
  });

  it("returns failed KycStatus on a 200 failed response", async () => {
    server.setHandler(() => ({
      status: 200,
      body: { status: "failed", reason: "synthetic" },
    }));
    const provider = new HttpKycProvider({ url: server.url, apiKey });
    expect(await provider.status("GABC")).toEqual({
      kind: "failed",
      reason: "synthetic",
    });
  });

  it("throws http_status on 5xx (and surfaces status code in error)", async () => {
    server.setHandler(() => ({ status: 502, body: { error: "down" } }));
    const provider = new HttpKycProvider({ url: server.url, apiKey });
    await expect(provider.status("GABC")).rejects.toMatchObject({
      name: "HttpProviderError",
      code: "http_status",
      status: 502,
    });
  });

  it("throws timeout when the server doesn't respond within timeoutMs", async () => {
    server.nextRequestShouldHang();
    const provider = new HttpKycProvider({
      url: server.url,
      apiKey,
      timeoutMs: 50,
    });
    await expect(provider.status("GABC")).rejects.toMatchObject({
      name: "HttpProviderError",
      code: "timeout",
    });
  });

  it("throws malformed on a 200 non-JSON body", async () => {
    server.setHandler(() => ({
      status: 200,
      contentType: "text/plain",
      body: "this is not JSON",
    }));
    const provider = new HttpKycProvider({ url: server.url, apiKey });
    await expect(provider.status("GABC")).rejects.toMatchObject({
      name: "HttpProviderError",
      code: "malformed",
    });
  });

  it("refuses empty url or apiKey at construction", () => {
    expect(() => new HttpKycProvider({ url: "", apiKey: "x" })).toThrow(/url/);
    expect(() => new HttpKycProvider({ url: "htt://x", apiKey: "" })).toThrow(
      /apiKey/
    );
  });
});

describe("HttpSanctionsProvider (standalone)", () => {
  let server: MockServer;
  beforeEach(async () => {
    server = await startMockServer();
  });
  afterEach(async () => {
    await server.close();
  });

  const apiKey = "test-sanctions-key";

  it("POSTs to {url}/sanctions/screen with Bearer auth and {address} body", async () => {
    server.setHandler(() => ({ status: 200, body: { hit: false } }));
    const provider = new HttpSanctionsProvider({ url: server.url, apiKey });
    await provider.hit("GABC").catch(() => undefined);
    const req = server.received[0];
    expect(req.path).toBe("/sanctions/screen");
    expect(req.method).toBe("POST");
    expect(req.authHeader).toBe(`Bearer ${apiKey}`);
    expect(JSON.parse(req.body)).toEqual({ address: "GABC" });
  });

  it("appends /sanctions/screen to a base URL with an existing path component (e.g. /v1)", async () => {
    server.setHandler(() => ({ status: 200, body: { hit: false } }));
    const provider = new HttpSanctionsProvider({
      url: `${server.url}/v1`,
      apiKey,
    });
    await provider.hit("GABC").catch(() => undefined);
    expect(server.received[0].path).toBe("/v1/sanctions/screen");
  });

  it("returns null on a no-hit response", async () => {
    server.setHandler(() => ({ status: 200, body: { hit: false } }));
    const provider = new HttpSanctionsProvider({ url: server.url, apiKey });
    expect(await provider.hit("GABC")).toBeNull();
  });

  it("returns SanctionsHit on a hit response", async () => {
    const expected: SanctionsHit = {
      list: "EU_CFSP",
      matched_field: "address",
      matched_value: "GABC",
    };
    server.setHandler(() => ({
      status: 200,
      body: { hit: true, ...expected },
    }));
    const provider = new HttpSanctionsProvider({ url: server.url, apiKey });
    expect(await provider.hit("GABC")).toEqual(expected);
  });

  it("throws malformed on a hit response with missing field detail", async () => {
    server.setHandler(() => ({ status: 200, body: { hit: true } }));
    const provider = new HttpSanctionsProvider({ url: server.url, apiKey });
    await expect(provider.hit("GABC")).rejects.toMatchObject({
      name: "HttpProviderError",
      code: "malformed",
    });
  });

  it("throws http_status on 5xx", async () => {
    server.setHandler(() => ({ status: 503, body: { error: "down" } }));
    const provider = new HttpSanctionsProvider({ url: server.url, apiKey });
    await expect(provider.hit("GABC")).rejects.toMatchObject({
      name: "HttpProviderError",
      code: "http_status",
      status: 503,
    });
  });

  it("refuses empty url or apiKey at construction", () => {
    expect(
      () => new HttpSanctionsProvider({ url: "", apiKey: "x" })
    ).toThrow(/url/);
    expect(
      () => new HttpSanctionsProvider({ url: "htt://x", apiKey: "" })
    ).toThrow(/apiKey/);
  });
});

// ── End-to-end /tx-approve against the mock HTTP server ───────────────────

describe("POST /tx-approve driving HttpKycProvider + HttpSanctionsProvider end-to-end", () => {
  let server: MockServer;
  beforeEach(async () => {
    server = await startMockServer();
  });
  afterEach(async () => {
    await server.close();
  });

  function makeApp() {
    const kyc = new HttpKycProvider({
      url: server.url,
      apiKey: "kyc-key",
      timeoutMs: 1000,
    });
    const sanctions = new HttpSanctionsProvider({
      url: server.url,
      apiKey: "sanctions-key",
      timeoutMs: 1000,
    });
    return buildApp(kyc, sanctions);
  }

  function routeByPath(
    handler: (req: ReceivedRequest) => HandlerReturn
  ): (req: ReceivedRequest) => HandlerReturn {
    return (req) => {
      if (req.path === "/kyc/screen" || req.path === "/sanctions/screen") {
        return handler(req);
      }
      return { status: 500, body: { error: "unexpected path " + req.path } };
    };
  }

  it("happy path: KYC verified + no sanctions → 200 approved", async () => {
    server.setHandler(
      routeByPath((req) => {
        if (req.path === "/kyc/screen")
          return {
            status: 200,
            body: { status: "verified", level: "enhanced" },
          };
        return { status: 200, body: { hit: false } };
      })
    );
    const res = await request(makeApp())
      .post("/tx-approve")
      .send({ tx: buildXdr(Keypair.random().publicKey()) });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    // Both providers were hit, in sanctions-first pipeline order.
    expect(server.received.map((r) => r.path)).toEqual([
      "/sanctions/screen",
      "/kyc/screen",
    ]);
  });

  it("sanctions hit via HTTP → 400 SANCTIONS_HIT (with documented response shape)", async () => {
    server.setHandler(
      routeByPath((req) => {
        if (req.path === "/sanctions/screen")
          return {
            status: 200,
            body: {
              hit: true,
              list: "OFAC_SDN",
              matched_field: "address",
              matched_value: "matched",
            },
          };
        // Sanctions runs first; KYC is unreachable in this scenario.
        return { status: 200, body: { status: "verified", level: "enhanced" } };
      })
    );
    const res = await request(makeApp())
      .post("/tx-approve")
      .send({ tx: buildXdr(Keypair.random().publicKey()) });
    expect(res.status).toBe(400);
    expect(res.body.status).toBe("rejected");
    expect(res.body.error_code).toBe("SANCTIONS_HIT");
    expect(res.body.details).toMatchObject({ list: "OFAC_SDN" });
    // Sanctions short-circuits the pipeline: KYC was not called.
    expect(server.received).toHaveLength(1);
    expect(server.received[0].path).toBe("/sanctions/screen");
  });

  it("KYC pending via HTTP → 200 pending (200 short-circuits the rest of the pipeline)", async () => {
    server.setHandler(
      routeByPath((req) => {
        if (req.path === "/sanctions/screen")
          return { status: 200, body: { hit: false } };
        return {
          status: 200,
          body: {
            status: "pending",
            action_url: "https://kyc.example/verify?ref=GABC",
          },
        };
      })
    );
    const res = await request(makeApp())
      .post("/tx-approve")
      .send({ tx: buildXdr(Keypair.random().publicKey()) });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending");
    expect(res.body.action_required).toMatch(/^https:\/\/kyc\.example/);
  });

  it("KYC failed via HTTP → 400 KYC_FAILED", async () => {
    server.setHandler(
      routeByPath((req) => {
        if (req.path === "/sanctions/screen")
          return { status: 200, body: { hit: false } };
        return {
          status: 200,
          body: { status: "failed", reason: "rejected by reviewer" },
        };
      })
    );
    const res = await request(makeApp())
      .post("/tx-approve")
      .send({ tx: buildXdr(Keypair.random().publicKey()) });
    expect(res.status).toBe(400);
    expect(res.body.error_code).toBe("KYC_FAILED");
    expect(res.body.error).toMatch(/rejected by reviewer/);
  });

  it("sanctions provider 5xx reaches Express 500 (no handler-level try/catch yet — pinned behaviour)", async () => {
    // The handler currently traps velocity errors only. KYC /
    // sanctions provider throws bubble to Express's default error
    // handler (empty body). When a future commit adds handler-level
    // try/catch around kyc/sanctions, this test will update to expect
    // the structured INTERNAL_ERROR response shape.
    server.setHandler(
      routeByPath(() => ({ status: 502, body: { error: "down" } }))
    );
    const res = await request(makeApp())
      .post("/tx-approve")
      .send({ tx: buildXdr(Keypair.random().publicKey()) });
    expect(res.status).toBe(500);
  });

  it("KYC provider timeout reaches Express 500 (no handler-level try/catch yet — pinned behaviour)", async () => {
    server.nextRequestShouldHang();
    const res = await request(makeApp())
      .post("/tx-approve")
      .send({ tx: buildXdr(Keypair.random().publicKey()) });
    expect(res.status).toBe(500);
  });

  it("malformed KYC JSON body surfaces as a non-200 (handler-level mapping not yet present)", async () => {
    server.setHandler(
      routeByPath((req) => {
        if (req.path === "/sanctions/screen")
          return { status: 200, body: { hit: false } };
        return {
          status: 200,
          contentType: "text/plain",
          body: "not JSON at all",
        };
      })
    );
    const res = await request(makeApp())
      .post("/tx-approve")
      .send({ tx: buildXdr(Keypair.random().publicKey()) });
    // Today: 500 with empty body — pinned for the same reason as
    // the 5xx / timeout tests above. Documented by the test comment.
    expect(res.status).toBe(500);
  });
});
