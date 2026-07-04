//! # SEP-0008 Compliance Hook Contract
//!
//! On-chain component of the SEP-0008 regulated asset compliance flow.
//!
//! ## How SEP-0008 Works
//! 1. A wallet constructs a transaction and submits it to the **compliance hook
//!    server** (off-chain, see `docs/sep0008-hook.md`).
//! 2. The server checks KYC/AML status, transaction limits, and sanctions lists.
//! 3. If approved, the server signs the transaction and returns it to the wallet.
//! 4. The wallet submits the signed transaction to Stellar.
//! 5. This on-chain contract records approvals for auditability and optional
//!    on-chain enforcement.
//!
//! ## Approval expiry
//! Each approval records the ledger sequence on which it was granted. An
//! approval is considered valid only while
//! `current_ledger <= approval_ledger + APPROVAL_TTL_LEDGERS`.
//!
//! ## MiCAR Relevance
//! - Art. 23: AML/CFT — every transfer is screened before execution
//! - Art. 46: transaction limits — enforced by the hook server
//! - Art. 22: travel rule — sender/receiver data collected by the hook server

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, BytesN, Env, Symbol,
};

/// How many ledgers an approval remains valid after being granted.
///
/// On Stellar the average ledger close time is ~5 s; 24 hours ≈ 17,280 ledgers.
pub const APPROVAL_TTL_LEDGERS: u32 = 17_280;

#[contracttype]
pub enum DataKey {
    Admin,
    HookServer,
    /// Approval record stored as `(BytesN<32>, u32)` where the second tuple
    /// element is the ledger sequence on which the approval was granted.
    Approval(BytesN<32>),
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
#[allow(dead_code)] // `Pending` reserved for admin escape hatches; not written today
pub enum ApprovalStatus {
    Pending,
    Approved,
    Rejected,
    /// An approval that was subsequently revoked by the hook server or admin.
    Revoked,
}

// ── Events ────────────────────────────────────────────────────────────────────
//
// `symbol_short!` is limited to 9 characters.

const APPROVED_EV: Symbol = symbol_short!("APPROVED");
const REJECTED_EV: Symbol = symbol_short!("REJECTED");
const REVOKED_EV: Symbol = symbol_short!("REVOKED");

#[contract]
pub struct ComplianceHook;

#[contractimpl]
impl ComplianceHook {
    pub fn initialize(env: Env, admin: Address, hook_server: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::HookServer, &hook_server);
        // Stamp instance storage TTL so the contract stays dispatchable
        // across long idle periods (and across the test-env ledger
        // advances that simulate them). Threshold ≈ 6 mo, extend-to ≈ 1 y.
        env.storage().instance().extend_ttl(3_153_600, 6_300_000);
    }

    // ── Approval / Rejection / Revocation ────────────────────────────────────

    /// Record an approval from the off-chain hook server.
    ///
    /// Only the designated hook server can call this. The stored approval
    /// expires after `APPROVAL_TTL_LEDGERS`.
    pub fn approve_transaction(env: Env, tx_hash: BytesN<32>) {
        let hook_server: Address = env.storage().instance().get(&DataKey::HookServer).unwrap();
        hook_server.require_auth();
        Self::store_approval(&env, &tx_hash, ApprovalStatus::Approved);
        env.events().publish((APPROVED_EV,), (tx_hash,));
    }

    /// Reject a transaction (e.g., sanctions hit).
    pub fn reject_transaction(env: Env, tx_hash: BytesN<32>) {
        let hook_server: Address = env.storage().instance().get(&DataKey::HookServer).unwrap();
        hook_server.require_auth();
        Self::store_approval(&env, &tx_hash, ApprovalStatus::Rejected);
        env.events().publish((REJECTED_EV,), (tx_hash,));
    }

    /// Revoke a previously granted approval. Caller must be the hook server.
    ///
    /// For emergency take-down by the admin, use `revoke_approval_by_admin`.
    /// Soroban's auth model is all-or-nothing per address, so we expose two
    /// entry points to keep the auth surface explicit and auditable.
    pub fn revoke_approval_by_server(env: Env, tx_hash: BytesN<32>) {
        let hook_server: Address = env.storage().instance().get(&DataKey::HookServer).unwrap();
        hook_server.require_auth();
        Self::store_approval(&env, &tx_hash, ApprovalStatus::Revoked);
        env.events().publish((REVOKED_EV,), (tx_hash,));
    }

    /// Revoke a previously granted approval. Caller must be the admin.
    /// Used for emergency take-downs by the issuer.
    pub fn revoke_approval_by_admin(env: Env, tx_hash: BytesN<32>) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        Self::store_approval(&env, &tx_hash, ApprovalStatus::Revoked);
        env.events().publish((REVOKED_EV,), (tx_hash,));
    }

    /// Returns true if `tx_hash` was approved **and** the approval has not
    /// expired.
    pub fn is_approved(env: Env, tx_hash: BytesN<32>) -> bool {
        let key = DataKey::Approval(tx_hash);
        let stored = env
            .storage()
            .persistent()
            .get::<_, (ApprovalStatus, u32)>(&key);
        match stored {
            Some((ApprovalStatus::Approved, ledger)) => {
                env.ledger().sequence() <= ledger.saturating_add(APPROVAL_TTL_LEDGERS)
            }
            _ => false,
        }
    }

    /// Return the raw approval status. Useful for off-chain indexers.
    pub fn approval_status(env: Env, tx_hash: BytesN<32>) -> Option<ApprovalStatus> {
        env.storage()
            .persistent()
            .get::<_, (ApprovalStatus, u32)>(&DataKey::Approval(tx_hash))
            .map(|(s, _)| s)
    }

    // ── Administration ───────────────────────────────────────────────────────

    /// Update the hook server address (e.g., key rotation).
    pub fn update_hook_server(env: Env, new_server: Address) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::HookServer, &new_server);
        env.storage().instance().extend_ttl(3_153_600, 6_300_000);
    }

    /// Transfer admin role.
    pub fn transfer_admin(env: Env, new_admin: Address) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.storage().instance().extend_ttl(3_153_600, 6_300_000);
    }

    // ── Internal Helpers ──────────────────────────────────────────────────────

    /// Write the approval record for `tx_hash` with the given `status` and
    /// stamp the entry's storage-level TTL so that `is_approved`,
    /// `approval_status`, and off-chain indexers can still read the entry
    /// throughout the full `APPROVAL_TTL_LEDGERS` window after it was written
    /// (and a margin beyond). Without this, Soroban's default ~4 096-ledger
    /// TTL means a single `.get(...)` past the window panics with a
    /// "contract instance key has been archived" host error rather than
    /// being able to surface the time-based `is_approved` decision.
    fn store_approval(env: &Env, tx_hash: &BytesN<32>, status: ApprovalStatus) {
        let key = DataKey::Approval(tx_hash.clone());
        env.storage()
            .persistent()
            .set(&key, &(status, env.ledger().sequence()));
        env.storage().persistent().extend_ttl(
            &key,
            APPROVAL_TTL_LEDGERS,
            APPROVAL_TTL_LEDGERS.saturating_mul(2),
        );
        // Also stamp the instance entry's TTL: any subsequent contract
        // call (including a simple `is_approved` query) must still find
        // the contract instance non-archived, otherwise the host panics
        // before our application logic ever runs (regression caught by
        // `test_approval_expires`).
        env.storage().instance().extend_ttl(3_153_600, 6_300_000);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::{BytesN, Env};

    /// Helper: advance the host ledger by `delta` ledgers and run `f`.
    fn with_ledger<F: FnOnce()>(env: &Env, delta: u32, f: F) {
        env.ledger().with_mut(|li| {
            li.sequence_number = li.sequence_number.saturating_add(delta);
        });
        f();
    }

    #[test]
    fn test_approve_and_check() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ComplianceHook);
        let client = ComplianceHookClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let server = Address::generate(&env);
        client.initialize(&admin, &server);

        let tx_hash = BytesN::from_array(&env, &[1u8; 32]);
        assert!(!client.is_approved(&tx_hash));

        client.approve_transaction(&tx_hash);
        assert!(client.is_approved(&tx_hash));
        assert_eq!(
            client.approval_status(&tx_hash),
            Some(ApprovalStatus::Approved)
        );
    }

    // ── New tests (no snapshots yet) ─────────────────────────────────────────

    #[test]
    fn test_reject_marks_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ComplianceHook);
        let client = ComplianceHookClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let server = Address::generate(&env);
        client.initialize(&admin, &server);

        let tx_hash = BytesN::from_array(&env, &[2u8; 32]);
        client.reject_transaction(&tx_hash);

        assert!(!client.is_approved(&tx_hash));
        assert_eq!(
            client.approval_status(&tx_hash),
            Some(ApprovalStatus::Rejected)
        );
    }

    #[test]
    fn test_approval_expires() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ComplianceHook);
        let client = ComplianceHookClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let server = Address::generate(&env);
        client.initialize(&admin, &server);

        let tx_hash = BytesN::from_array(&env, &[3u8; 32]);
        client.approve_transaction(&tx_hash);
        assert!(client.is_approved(&tx_hash));

        // Advance past the TTL.
        with_ledger(&env, APPROVAL_TTL_LEDGERS + 1, || {
            assert!(!client.is_approved(&tx_hash));
        });
    }

    #[test]
    fn test_revoke_marks_revoked() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ComplianceHook);
        let client = ComplianceHookClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let server = Address::generate(&env);
        client.initialize(&admin, &server);

        let tx_hash = BytesN::from_array(&env, &[4u8; 32]);
        client.approve_transaction(&tx_hash);
        client.revoke_approval_by_server(&tx_hash);

        assert!(!client.is_approved(&tx_hash));
        assert_eq!(
            client.approval_status(&tx_hash),
            Some(ApprovalStatus::Revoked)
        );

        // Admin path also revokes.
        let tx_hash2 = BytesN::from_array(&env, &[5u8; 32]);
        client.approve_transaction(&tx_hash2);
        client.revoke_approval_by_admin(&tx_hash2);
        assert_eq!(
            client.approval_status(&tx_hash2),
            Some(ApprovalStatus::Revoked)
        );
    }

    #[test]
    fn test_unknown_tx_returns_none() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ComplianceHook);
        let client = ComplianceHookClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let server = Address::generate(&env);
        client.initialize(&admin, &server);

        let tx_hash = BytesN::from_array(&env, &[9u8; 32]);
        assert_eq!(client.approval_status(&tx_hash), None);
        assert!(!client.is_approved(&tx_hash));
    }

    #[test]
    #[should_panic(expected = "already initialized")]
    fn test_double_initialize_blocked() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ComplianceHook);
        let client = ComplianceHookClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let server = Address::generate(&env);
        client.initialize(&admin, &server);
        client.initialize(&admin, &server);
    }
}
