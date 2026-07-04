/**
 * @eur-emt/sdk
 *
 * Public entry point. Re-exports the client plus its public types and the
 * `Networks` helper from the underlying Stellar SDK.
 */

export { EmtClient, EmtClientError } from "./EmtClient";
export type { EmtClientConfig, SubmitResult } from "./EmtClient";
export { Networks } from "@stellar/stellar-sdk";
