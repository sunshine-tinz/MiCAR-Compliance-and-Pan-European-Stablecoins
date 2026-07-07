/**
 * Vendor-neutral HTTP POST/JSON helper used by every real
 * (non-mock) compliance provider client.
 *
 * Centralises the parts that would otherwise be duplicated between
 * HttpKycProvider and HttpSanctionsProvider:
 *
 *   - URL trailing-slash normalisation,
 *   - Bearer-auth header construction,
 *   - JSON request-body serialisation,
 *   - `AbortController` timeout (5 s default, overridable),
 *   - structured error throws that surface a parseable code path
 *     to the handler's `INTERNAL_ERROR` mapping
 *     (`{ status, statusText, cause }` shape).
 *
 * Kept narrow on purpose — every provider still owns its own response
 * parser and domain mapping, since the schemas differ across
 * providers (KYC vs sanctions). This file is the **transport** layer
 * only.
 */

/** Options for {@link postJson}. */
export interface PostJsonOptions {
  /** Base URL of the provider endpoint (e.g. `https://api.example.com`). */
  url: string;
  /** Bearer token sent in `Authorization: Bearer <token>`. */
  apiKey: string;
  /** JSON body sent to the provider (serialised with `JSON.stringify`). */
  body: unknown;
  /**
   * Request timeout in milliseconds. Default: 5000. Triggers an
   * `AbortError` if the provider hasn't responded by then; the error
   * is converted to a structured `Error` so the handler logs a
   * coherent `INTERNAL_ERROR` reason.
   */
  timeoutMs?: number;
  /** Optional fetch init overrides (e.g. custom headers). */
  fetchInit?: RequestInit;
}

/**
 * Returns the parsed JSON body of a successful (2xx) response.
 *
 * Throws with a stable shape:
 *
 *   ```
 *   { name: "HttpProviderError", code: <one of the strings below>,
 *     status?: number, statusText?: string, cause?: unknown }
 *   ```
 *
 * `code` is one of:
 *
 *   - `"network"`     — DNS / TCP / TLS / fetch threw
 *   - `"timeout"`     — `AbortController` fired
 *   - `"http_status"` — non-2xx status; `status` + `statusText` set
 *   - `"malformed"`   — body was not valid JSON, or didn't match the
 *                        provider's contract
 */
export async function postJson<T = unknown>(
  options: PostJsonOptions
): Promise<T> {
  const endpoint = options.url.replace(/\/+$/, "");
  const ctl = new AbortController();
  const timeoutMs = options.timeoutMs ?? 5000;
  const timer = setTimeout(() => ctl.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: options.apiKey ? `Bearer ${options.apiKey}` : "",
        ...(options.fetchInit?.headers as Record<string, string> | undefined),
      },
      body: JSON.stringify(options.body),
      signal: ctl.signal,
      ...options.fetchInit,
    });
  } catch (err) {
    clearTimeout(timer);
    const e = err as Error;
    // AbortError surfaces both for an explicit `.abort()` AND for the
    // timeout path — distinguish timer-induced aborts by name (the
    // platform uses "AbortError" or "The operation was aborted").
    const aborted = e.name === "AbortError" || /abort/i.test(e.message);
    throw new HttpProviderError(aborted ? "timeout" : "network", e.message, e);
  }
  clearTimeout(timer);

  if (!response.ok) {
    // Drain the body before throwing so the socket can be reused on
    // HTTP/1.1 keepalive. The text is included in the error for ops
    // debugging but truncated to keep logs manageable.
    let snippet = "";
    try {
      snippet = (await response.text()).slice(0, 256);
    } catch {
      // ignore — failure to read body is secondary
    }
    throw new HttpProviderError(
      "http_status",
      `${response.status} ${response.statusText}${snippet ? `: ${snippet}` : ""}`,
      undefined,
      response.status,
      response.statusText
    );
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch (err) {
    throw new HttpProviderError(
      "malformed",
      `provider returned non-JSON body: ${(err as Error).message}`,
      err
    );
  }
  return raw as T;
}

/** Structured error type so the handler can log / branch on `code`. */
export class HttpProviderError extends Error {
  public readonly code:
    | "network"
    | "timeout"
    | "http_status"
    | "malformed";
  public readonly cause?: unknown;
  public readonly status?: number;
  public readonly statusText?: string;

  constructor(
    code: HttpProviderError["code"],
    message: string,
    cause?: unknown,
    status?: number,
    statusText?: string
  ) {
    super(`[${code}] ${message}`);
    this.name = "HttpProviderError";
    this.code = code;
    this.cause = cause;
    this.status = status;
    this.statusText = statusText;
  }
}
