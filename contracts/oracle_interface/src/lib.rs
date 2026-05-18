//! # Oracle Interface Contract
//!
//! Bridges off-chain reserve attestation data onto the Stellar ledger.
//!
//! ## Purpose
//! MiCAR Art. 45 requires EMT issuers to hold reserve assets equal to the
//! outstanding token supply, segregated from the issuer's own assets.
//! This contract provides a verifiable on-chain record of:
//! - Current reserve balance (reported by authorised attestors)
//! - Token supply at time of attestation
//! - Attestation document hash (IPFS CID or SHA-256)
//!
//! ## Trust Model
//! The oracle is a **push oracle**: authorised attestors (e.g., auditors,
//! custodians) push signed attestations. The EMT token contract reads from
//! this oracle before allowing large mints.
//!
//! ## TODO for Contributors
//! - [ ] Implement multi-attestor quorum (require M-of-N attestors to agree)
//! - [ ] Add staleness check: reject attestations older than 24 hours
//! - [ ] Implement `get_collateral_ratio` helper used by emt_token
//! - [ ] Add support for multiple reserve currencies (EUR bank + T-bills)
//! - [ ] Write tests for quorum logic and staleness
//! - [ ] Integrate with a real custodian API (e.g., Fireblocks, Copper)

#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, String};

#[contracttype]
pub enum DataKey {
    Admin,
    /// Attestation record keyed by sequence number
    Attestation(u64),
    LatestSeq,
    /// Authorised attestor addresses
    Attestor(Address),
}

#[contracttype]
#[derive(Clone)]
pub struct Attestation {
    /// Reserve balance in EUR cents (to avoid floats)
    pub reserve_balance: i128,
    /// Token supply at time of attestation
    pub token_supply: i128,
    /// IPFS CID or SHA-256 hex of the attestation document
    pub document_hash: String,
    /// Stellar ledger number at time of submission
    pub ledger: u32,
}

#[contract]
pub struct OracleInterface;

#[contractimpl]
impl OracleInterface {
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::LatestSeq, &0u64);
    }

    /// Add an authorised attestor.
    pub fn add_attestor(env: Env, attestor: Address) {
        Self::require_admin(&env);
        env.storage()
            .persistent()
            .set(&DataKey::Attestor(attestor), &true);
    }

    /// Remove an attestor.
    pub fn remove_attestor(env: Env, attestor: Address) {
        Self::require_admin(&env);
        env.storage()
            .persistent()
            .set(&DataKey::Attestor(attestor), &false);
    }

    /// Submit a new reserve attestation.
    ///
    /// Caller must be an authorised attestor.
    ///
    /// # TODO
    /// - Require quorum of attestors before recording
    /// - Validate reserve_balance >= token_supply (over-collateralisation check)
    pub fn submit_attestation(
        env: Env,
        attestor: Address,
        reserve_balance: i128,
        token_supply: i128,
        document_hash: String,
    ) {
        attestor.require_auth();
        let is_attestor: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Attestor(attestor.clone()))
            .unwrap_or(false);
        assert!(is_attestor, "not an authorised attestor");

        let seq: u64 = env
            .storage()
            .instance()
            .get(&DataKey::LatestSeq)
            .unwrap_or(0);
        let next_seq = seq + 1;

        let attestation = Attestation {
            reserve_balance,
            token_supply,
            document_hash,
            ledger: env.ledger().sequence(),
        };

        env.storage()
            .persistent()
            .set(&DataKey::Attestation(next_seq), &attestation);
        env.storage()
            .instance()
            .set(&DataKey::LatestSeq, &next_seq);
    }

    /// Get the latest attestation.
    pub fn latest_attestation(env: Env) -> Option<Attestation> {
        let seq: u64 = env
            .storage()
            .instance()
            .get(&DataKey::LatestSeq)
            .unwrap_or(0);
        if seq == 0 {
            return None;
        }
        env.storage()
            .persistent()
            .get(&DataKey::Attestation(seq))
    }

    /// Get attestation by sequence number (for historical audit).
    pub fn get_attestation(env: Env, seq: u64) -> Option<Attestation> {
        env.storage()
            .persistent()
            .get(&DataKey::Attestation(seq))
    }

    fn require_admin(env: &Env) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{Env, String};

    #[test]
    fn test_submit_and_retrieve_attestation() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(OracleInterface, ());
        let client = OracleInterfaceClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let attestor = Address::generate(&env);
        client.initialize(&admin);
        client.add_attestor(&attestor);

        client.submit_attestation(
            &attestor,
            &1_000_000_00i128, // 1,000,000.00 EUR
            &999_000_00i128,   // 999,000.00 EUR tokens outstanding
            &String::from_str(&env, "QmExampleIPFSHash"),
        );

        let att = client.latest_attestation().unwrap();
        assert_eq!(att.reserve_balance, 1_000_000_00);
        assert_eq!(att.token_supply, 999_000_00);
    }

    // TODO: test quorum, staleness, unauthorised attestor rejection
}
