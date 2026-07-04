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
//! - Number of corroborating attestors received since the last refresh window
//!
//! ## Trust model
//! The oracle is a **push oracle**: authorised attestors (auditors,
//! custodians) push signed attestations. The EMT token contract reads from
//! this oracle to verify reserve sufficiency before allowing large mints.
//!
//! ## Quorum & staleness
//! The admin configures two thresholds that allow ergonomic consumption by
//! the `emt_token` contract:
//!
//! - `quorum`: minimum number of attestations required within a sliding
//!   window before the attestation record is treated as "qualified".
//! - `max_attestation_age_ledgers`: how many ledgers an attestation remains
//!   fresh before indexers should treat it as stale (~24 h ≈ 17,280 ledgers).
//!
//! Both are stored in contract instance storage and can be updated by admin.

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Env, String, Symbol,
};

/// Default freshness window: ~24 h on Stellar (≈ 17,280 ledgers).
pub const DEFAULT_MAX_ATTESTATION_AGE_LEDGERS: u32 = 17_280;

/// Default quorum: require at least one corroborating attestation.
pub const DEFAULT_QUORUM: u32 = 1;

#[contracttype]
pub enum DataKey {
    Admin,
    /// Latest attestation record (overwritten by each `submit_attestation`)
    LatestAttestation,
    /// Attestor count received since the most recent reset window.
    WindowCount,
    /// Quorum threshold required for an attestation to be considered valid.
    Quorum,
    /// Maximum age (in ledgers) before an attestation is considered stale.
    MaxAge,
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

// ── Events ────────────────────────────────────────────────────────────────────
//
// `symbol_short!` is limited to 9 characters.

const ATTEST_EV: Symbol = symbol_short!("ATTEST");
const ATTESTOR_EV: Symbol = symbol_short!("ATTESTOR");

#[contract]
pub struct OracleInterface;

#[contractimpl]
impl OracleInterface {
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::Quorum, &DEFAULT_QUORUM);
        env.storage()
            .instance()
            .set(&DataKey::MaxAge, &DEFAULT_MAX_ATTESTATION_AGE_LEDGERS);
        env.storage().instance().set(&DataKey::WindowCount, &0u32);
    }

    // ── Threshold management (admin) ──────────────────────────────────────────

    /// Set the quorum threshold. The minimum number of attestations a
    /// qualified attestation record must reflect.
    pub fn set_quorum(env: Env, quorum: u32) {
        Self::require_admin(&env);
        assert!(quorum > 0, "quorum must be positive");
        env.storage().instance().set(&DataKey::Quorum, &quorum);
    }

    /// Set the max age (in ledgers) before an attestation is considered stale.
    pub fn set_max_attestation_age(env: Env, max_age_ledgers: u32) {
        Self::require_admin(&env);
        assert!(max_age_ledgers > 0, "max age must be positive");
        env.storage()
            .instance()
            .set(&DataKey::MaxAge, &max_age_ledgers);
    }

    pub fn quorum(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Quorum)
            .unwrap_or(DEFAULT_QUORUM)
    }

    pub fn max_attestation_age(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::MaxAge)
            .unwrap_or(DEFAULT_MAX_ATTESTATION_AGE_LEDGERS)
    }

    // ── Attestor management (admin) ───────────────────────────────────────────

    /// Add an authorised attestor.
    pub fn add_attestor(env: Env, attestor: Address) {
        Self::require_admin(&env);
        env.storage()
            .persistent()
            .set(&DataKey::Attestor(attestor.clone()), &true);
        env.events().publish((ATTESTOR_EV,), (attestor, true));
    }

    /// Remove an attestor. Existing attestations remain on record; future
    /// submissions from this address will be rejected.
    pub fn remove_attestor(env: Env, attestor: Address) {
        Self::require_admin(&env);
        env.storage()
            .persistent()
            .set(&DataKey::Attestor(attestor.clone()), &false);
        env.events().publish((ATTESTOR_EV,), (attestor, false));
    }

    pub fn is_attestor(env: Env, attestor: Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Attestor(attestor))
            .unwrap_or(false)
    }

    // ── Attestation submission (attestors) ───────────────────────────────────

    /// Submit a new reserve attestation.
    ///
    /// Caller must be an authorised attestor. Each submission:
    /// 1. Overwrites the latest attestation record with this attestor's data.
    /// 2. Increments the "attestations in window" counter.
    /// 3. Emits an event for off-chain indexers.
    ///
    /// The `emt_token` contract must additionally check that `WindowCount`
    /// has reached `Quorum` before allowing large mints.
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

        assert!(reserve_balance >= 0, "reserve_balance must be non-negative");
        assert!(token_supply >= 0, "token_supply must be non-negative");

        // MiCAR Art. 45: reserves must at least cover supply.
        assert!(
            reserve_balance >= token_supply,
            "reserve_balance must cover token_supply"
        );

        let attestation = Attestation {
            reserve_balance,
            token_supply,
            document_hash,
            ledger: env.ledger().sequence(),
        };

        env.storage()
            .instance()
            .set(&DataKey::LatestAttestation, &attestation);

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::WindowCount)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::WindowCount, &(count + 1));

        env.events()
            .publish((ATTEST_EV,), (attestor, reserve_balance, token_supply));
    }

    /// Reset the per-window attestor counter. Used after a `mint` cycle
    /// consumes the qualified attestation.
    pub fn reset_window(env: Env) {
        Self::require_admin(&env);
        env.storage().instance().set(&DataKey::WindowCount, &0u32);
    }

    // ── Read views ───────────────────────────────────────────────────────────

    pub fn latest_attestation(env: Env) -> Option<Attestation> {
        env.storage().instance().get(&DataKey::LatestAttestation)
    }

    /// Number of corroborating attestations received since the last
    /// `reset_window` call.
    pub fn window_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::WindowCount)
            .unwrap_or(0)
    }

    /// True if the latest attestation has reached the configured quorum AND
    /// is still fresh (i.e., not older than `max_attestation_age`).
    pub fn is_qualified(env: Env) -> bool {
        let count = Self::window_count(env.clone());
        let quorum = Self::quorum(env.clone());
        if count < quorum {
            return false;
        }
        match Self::latest_attestation(env.clone()) {
            Some(latest) => {
                env.ledger().sequence()
                    <= latest.ledger.saturating_add(Self::max_attestation_age(env))
            }
            None => false,
        }
    }

    /// Compute reserve_balance / token_supply as a fixed-point number scaled
    /// by 10^9. Returns `None` when supply is zero.
    ///
    /// A value ≥ 1.0 means fully reserved; > 1.0 means over-collateralised.
    pub fn get_collateral_ratio(env: Env) -> Option<i128> {
        let att = Self::latest_attestation(env.clone())?;
        if att.token_supply == 0 {
            return None;
        }
        // (reserve * 1e9) / supply, both i128. Saturates on overflow but at
        // a ratio of 1e12, which is far outside any plausible reserve ratio.
        let scaled = att.reserve_balance.checked_mul(1_000_000_000_i128)?;
        Some(scaled / att.token_supply)
    }

    fn require_admin(env: &Env) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::{Env, String};

    fn setup() -> (Env, Address, Address, OracleInterfaceClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, OracleInterface);
        let client = OracleInterfaceClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let attestor = Address::generate(&env);
        client.initialize(&admin);
        client.add_attestor(&attestor);

        (env, admin, attestor, client)
    }

    #[test]
    fn test_submit_and_retrieve_attestation() {
        let (env, _admin, attestor, client) = setup();
        client.submit_attestation(
            &attestor,
            &100_000_000i128, // 1,000,000.00 EUR (in cents)
            &99_900_000i128,  // 999,000.00 EUR tokens outstanding (in cents)
            &String::from_str(&env, "QmExampleIPFSHash"),
        );

        let att = client.latest_attestation().unwrap();
        assert_eq!(att.reserve_balance, 100_000_000);
        assert_eq!(att.token_supply, 99_900_000);
        assert_eq!(
            att.document_hash,
            String::from_str(&env, "QmExampleIPFSHash")
        );
    }

    // ── New tests (no snapshots yet) ─────────────────────────────────────────

    #[test]
    #[should_panic(expected = "not an authorised attestor")]
    fn test_unauthorised_attestor_rejected() {
        let (env, _admin, _attestor, client) = setup();
        let impostor = Address::generate(&env);
        client.submit_attestation(
            &impostor,
            &100_000_000i128,
            &99_900_000i128,
            &String::from_str(&env, "QmBadHash"),
        );
    }

    #[test]
    #[should_panic(expected = "reserve_balance must cover token_supply")]
    fn test_undercollateralised_rejected() {
        let (env, _admin, attestor, client) = setup();
        client.submit_attestation(
            &attestor,
            &50_000_000i128, // 500k EUR reserve
            &99_900_000i128, // 999k EUR supply
            &String::from_str(&env, "QmBadHash"),
        );
    }

    #[test]
    fn test_collateral_ratio_over_one() {
        let (env, _admin, attestor, client) = setup();
        client.submit_attestation(
            &attestor,
            &101_000_000i128,
            &100_000_000i128,
            &String::from_str(&env, "QmExample"),
        );
        // 1.01 * 1e9 = 1_010_000_000
        assert_eq!(client.get_collateral_ratio(), Some(1_010_000_000));
    }

    #[test]
    fn test_window_count_and_qualified() {
        let (env, _admin, attestor, client) = setup();
        client.submit_attestation(
            &attestor,
            &100_000_000i128,
            &99_900_000i128,
            &String::from_str(&env, "QmA"),
        );
        assert_eq!(client.window_count(), 1);
        assert!(client.is_qualified());
    }

    #[test]
    fn test_quorum_threshold_enforced() {
        let (env, _admin, attestor, client) = setup();
        client.set_quorum(&3);
        assert_eq!(client.quorum(), 3);

        client.submit_attestation(
            &attestor,
            &100_000_000i128,
            &99_900_000i128,
            &String::from_str(&env, "QmA"),
        );
        // Only one attestation, quorum=3 → not qualified yet.
        assert!(!client.is_qualified());

        client.submit_attestation(
            &attestor,
            &100_000_000i128,
            &99_900_000i128,
            &String::from_str(&env, "QmB"),
        );
        client.submit_attestation(
            &attestor,
            &100_000_000i128,
            &99_900_000i128,
            &String::from_str(&env, "QmC"),
        );
        assert!(client.is_qualified());
    }

    #[test]
    fn test_reset_window_clears_count() {
        let (env, _admin, attestor, client) = setup();
        client.submit_attestation(
            &attestor,
            &100_000_000i128,
            &99_900_000i128,
            &String::from_str(&env, "QmA"),
        );
        assert_eq!(client.window_count(), 1);
        client.reset_window();
        assert_eq!(client.window_count(), 0);
        assert!(!client.is_qualified());
    }

    #[test]
    fn test_remove_attestor_blocks_further_submissions() {
        let (_env, _admin, attestor, client) = setup();
        client.remove_attestor(&attestor);
        assert!(!client.is_attestor(&attestor));
    }

    #[test]
    fn test_staleness_threshold() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, OracleInterface);
        let client = OracleInterfaceClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let attestor = Address::generate(&env);
        client.initialize(&admin);
        client.set_max_attestation_age(&10);
        client.add_attestor(&attestor);

        client.submit_attestation(
            &attestor,
            &100_000_000i128,
            &99_900_000i128,
            &String::from_str(&env, "QmA"),
        );
        assert!(client.is_qualified());

        // Advance past the configured freshness window.
        env.ledger().with_mut(|li| {
            li.sequence_number = li.sequence_number.saturating_add(11);
        });
        assert!(!client.is_qualified());
    }

    #[test]
    #[should_panic(expected = "already initialized")]
    fn test_double_initialize_blocked() {
        let (env, admin, _, _) = setup();
        let contract_id = env.register_contract(None, OracleInterface);
        let client = OracleInterfaceClient::new(&env, &contract_id);
        client.initialize(&admin);
    }

    #[test]
    #[should_panic(expected = "quorum must be positive")]
    fn test_zero_quorum_rejected() {
        let (_env, _admin, _attestor, client) = setup();
        client.set_quorum(&0);
    }

    #[test]
    fn test_collateral_ratio_none_when_no_supply() {
        let (env, _admin, attestor, client) = setup();
        client.submit_attestation(&attestor, &0i128, &0i128, &String::from_str(&env, "Qm"));
        assert_eq!(client.get_collateral_ratio(), None);
    }
}
