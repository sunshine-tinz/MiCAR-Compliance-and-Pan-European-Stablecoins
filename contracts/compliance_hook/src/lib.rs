//! # SEP-0008 Compliance Hook Contract
//!
//! On-chain component of the SEP-0008 regulated asset compliance flow.
//!
//! ## How SEP-0008 Works
//! 1. A wallet constructs a transaction and submits it to the **compliance hook
//!    server** (off-chain, see `scripts/sep0008-server/`).
//! 2. The server checks KYC/AML status, transaction limits, and sanctions lists.
//! 3. If approved, the server signs the transaction and returns it to the wallet.
//! 4. The wallet submits the signed transaction to Stellar.
//! 5. This on-chain contract can optionally record approvals for auditability.
//!
//! ## MiCAR Relevance
//! - Art. 23: AML/CFT — every transfer is screened before execution
//! - Art. 46: transaction limits — enforced by the hook server
//! - Art. 22: travel rule — sender/receiver data collected by the hook server
//!
//! ## TODO for Contributors
//! - [ ] Implement `approve_transaction` to record hook server approvals on-chain
//! - [ ] Add approval expiry (approvals should expire after N ledgers)
//! - [ ] Implement `revoke_approval` for emergency use
//! - [ ] Add rate-limiting: max N approvals per address per day
//! - [ ] Write integration tests with a mock hook server
//! - [ ] Document the off-chain hook server API (OpenAPI spec)

#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env};

#[contracttype]
pub enum DataKey {
    Admin,
    HookServer,
    /// Approval record: tx_hash → ApprovalStatus
    Approval(BytesN<32>),
}

#[contracttype]
#[derive(Clone, PartialEq)]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Rejected,
}

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
    }

    /// Record an approval from the off-chain hook server.
    ///
    /// Only the designated hook server address can call this.
    /// `tx_hash` is the SHA-256 hash of the transaction envelope XDR.
    ///
    /// # TODO
    /// - Store approval timestamp and expiry ledger
    /// - Emit an event for indexers
    pub fn approve_transaction(env: Env, tx_hash: BytesN<32>) {
        let hook_server: Address = env.storage().instance().get(&DataKey::HookServer).unwrap();
        hook_server.require_auth();

        env.storage()
            .persistent()
            .set(&DataKey::Approval(tx_hash), &ApprovalStatus::Approved);
    }

    /// Reject a transaction (e.g., sanctions hit).
    pub fn reject_transaction(env: Env, tx_hash: BytesN<32>) {
        let hook_server: Address = env.storage().instance().get(&DataKey::HookServer).unwrap();
        hook_server.require_auth();

        env.storage()
            .persistent()
            .set(&DataKey::Approval(tx_hash), &ApprovalStatus::Rejected);
    }

    /// Check whether a transaction has been approved.
    pub fn is_approved(env: Env, tx_hash: BytesN<32>) -> bool {
        matches!(
            env.storage()
                .persistent()
                .get::<_, ApprovalStatus>(&DataKey::Approval(tx_hash)),
            Some(ApprovalStatus::Approved)
        )
    }

    /// Update the hook server address (e.g., key rotation).
    pub fn update_hook_server(env: Env, new_server: Address) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::HookServer, &new_server);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{BytesN, Env};

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
    }

    // TODO: test rejection, expiry, rate limiting
}
