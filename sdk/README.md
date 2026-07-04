# `@eur-emt/sdk` — TypeScript client for the MiCAR EMT contract

TypeScript SDK wrapping the Soroban EMT token contract with typed methods
for reads (no transaction) and writes (build → simulate → sign → submit).

## Install

```bash
cd sdk
npm install
npm run build
```

## Typical usage

```ts
import { EmtClient, Keypair, Networks } from "@eur-emt/sdk";
import { rpcUrl } from "./config";

const client = new EmtClient({
  contractId: process.env.EMT_CONTRACT_ID!,
  networkPassphrase: Networks.TESTNET,
  rpcUrl,
});

const aliceKey = Keypair.fromSecret(process.env.ALICE_SECRET!);
const bob = "G..."; // recipient public key

const tx = await client.transfer({
  from: aliceKey.publicKey(),
  to: bob,
  amount: 1_000_000n, // 0.1 EUREMT
  sourceKeypair: aliceKey,
});
console.log("transfer tx hash:", tx.hash);
```

## Read methods (no transaction)

| Method | Returns | Notes |
|---|---|---|
| `getBalance(address)` | `bigint` | Smallest unit (7 decimals) |
| `getTotalSupply()` | `bigint` | — |
| `isPaused()` | `boolean` | — |
| `isBlocklisted(address)` | `boolean` | — |
| `getAllowance(owner, spender)` | `bigint` | ERC-20-style |
| `getName()` / `getSymbol()` | `string` | Static metadata |
| `getDecimals()` | `number` | Always `7` |
| `getReserveAttestation()` | `string \| null` | IPFS CID or hash |
| `getPendingAdmin()` | `string \| null` | Address proposed for admin role |

## Write methods (each signs, submits, awaits confirmation)

| Method | Required signer |
|---|---|
| `transfer({ from, to, amount, sourceKeypair })` | `from` |
| `mint({ to, amount, sourceKeypair })` | minter |
| `burn({ from, amount, sourceKeypair })` | minter |
| `approve({ from, spender, amount, sourceKeypair })` | `from` |
| `transferFrom({ spender, from, to, amount, sourceKeypair })` | `spender` |
| `pause(sourceKeypair)` | pauser |
| `unpause(sourceKeypair)` | pauser |
| `blocklist({ account, sourceKeypair })` | blocklister |
| `unblocklist({ account, sourceKeypair })` | blocklister |
| `clawback({ from, amount, sourceKeypair })` | admin |
| `setReserveAttestation({ hash, sourceKeypair })` | admin |
| `proposeAdmin({ newAdmin, sourceKeypair })` | current admin |
| `acceptAdmin(sourceKeypair)` | proposed successor |
| `cancelProposedAdmin(sourceKeypair)` | current admin |

All write methods return a `SubmitResult` containing the transaction hash,
decoded result (if applicable), and final status.

## Errors

Methods throw `EmtClientError` on RPC or simulation failures and on
contract panics (the host `Error` string is preserved on `.message`).

```ts
try {
  await client.transfer({ ... });
} catch (e) {
  if (e instanceof EmtClientError && e.message.includes("insufficient balance")) {
    // handle
  }
}
```
