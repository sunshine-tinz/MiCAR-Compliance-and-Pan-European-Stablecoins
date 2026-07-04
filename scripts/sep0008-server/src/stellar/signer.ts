/**
 * Stellar transaction signer.
 *
 * Wraps a `Keypair` so the handler can sign approved transactions
 * without reaching into the SDK directly. The signing key is loaded
 * once at startup (from HOOK_SERVER_SECRET_KEY) and lives in memory
 * for the process lifetime.
 */

import { Keypair, Transaction } from "@stellar/stellar-sdk";

export class StellarSigner {
  constructor(public readonly keypair: Keypair) {}

  sign(tx: Transaction): Transaction {
    tx.sign(this.keypair);
    return tx;
  }

  /** The public Stellar address of this signer (G...). */
  get address(): string {
    return this.keypair.publicKey();
  }
}
