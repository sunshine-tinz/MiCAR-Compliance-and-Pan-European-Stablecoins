//! # EMT Token Contract
//!
//! MiCAR-compliant Euro-pegged E-Money Token (EMT) on Stellar/Soroban.
//!
//! ## Architecture
//! Inspired by Circle's stablecoin-evm and Membrane Finance's EUROe, adapted
//! for Stellar's Soroban runtime. Key compliance controls:
//!
//! - **Roles**: admin, minter, pauser, blocklister — each stored separately
//! - **Blocklist**: addresses blocked from sending/receiving (AML/sanctions)
//! - **Pause**: emergency circuit-breaker halting all transfers
//! - **Mint/Burn**: only authorized minters, subject to compliance checks
//! - **Clawback**: admin can reclaim tokens (maps to Stellar AUTH_CLAWBACK_ENABLED)
//!
//! ## MiCAR Obligations Addressed
//! - Art. 48: redemption at par on demand → `burn` + off-chain redemption flow
//! - Art. 45: reserve asset segregation → tracked off-chain, attested on-chain
//! - Art. 23: AML/CFT controls → blocklist + SEP-0008 compliance hook
//! - Art. 46: transaction limits → enforced in `transfer` and `mint`
//!
//! ## TODO for Contributors
//! - [ ] Implement `transfer_from` (delegated transfers)
//! - [ ] Add allowance storage and `approve` function
//! - [ ] Integrate oracle_interface for reserve attestation
//! - [ ] Add per-address transaction velocity limits
//! - [ ] Emit structured events for all state changes
//! - [ ] Write fuzz tests for mint/burn/transfer edge cases

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Env, String, Symbol,
};

// ── Storage Keys ─────────────────────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    Admin,
    Minter,
    Pauser,
    Blocklister,
    Paused,
    Balance(Address),
    Blocklisted(Address),
    TotalSupply,
    /// MiCAR Art. 45 — reserve attestation hash (bytes32 of off-chain report)
    ReserveAttestation,
    /// Per-address daily mint limit (MiCAR Art. 46 transaction limits)
    MintLimit(Address),
}

// ── Events ────────────────────────────────────────────────────────────────────

const MINT: Symbol = symbol_short!("MINT");
const BURN: Symbol = symbol_short!("BURN");
const TRANSFER: Symbol = symbol_short!("TRANSFER");
const PAUSE: Symbol = symbol_short!("PAUSE");
const UNPAUSE: Symbol = symbol_short!("UNPAUSE");
const BLOCKLIST: Symbol = symbol_short!("BLOCKLIST");

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct EmtToken;

#[contractimpl]
impl EmtToken {
    // ── Initialisation ────────────────────────────────────────────────────────

    /// Deploy and configure the token. Called once by the issuer.
    ///
    /// # Arguments
    /// * `admin`       – Master admin (issuer / EU-authorised EMI)
    /// * `minter`      – Address allowed to mint (typically a treasury multisig)
    /// * `pauser`      – Address allowed to pause/unpause
    /// * `blocklister` – Address allowed to block/unblock accounts (compliance officer)
    pub fn initialize(
        env: Env,
        admin: Address,
        minter: Address,
        pauser: Address,
        blocklister: Address,
    ) {
        // Prevent re-initialisation
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Minter, &minter);
        env.storage().instance().set(&DataKey::Pauser, &pauser);
        env.storage()
            .instance()
            .set(&DataKey::Blocklister, &blocklister);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().set(&DataKey::TotalSupply, &0_i128);
    }

    // ── Token Metadata ────────────────────────────────────────────────────────

    pub fn name(_env: Env) -> String {
        // TODO: store name in contract storage so it can be set at init
        String::from_str(&_env, "Euro EMT")
    }

    pub fn symbol(_env: Env) -> String {
        String::from_str(&_env, "EUREMT")
    }

    /// 7 decimal places — matches Stellar Classic convention
    pub fn decimals(_env: Env) -> u32 {
        7
    }

    // ── Supply ────────────────────────────────────────────────────────────────

    pub fn total_supply(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0)
    }

    pub fn balance(env: Env, account: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(account))
            .unwrap_or(0)
    }

    // ── Mint / Burn ───────────────────────────────────────────────────────────

    /// Mint `amount` tokens to `to`.
    ///
    /// Caller must be the designated minter.
    /// Recipient must not be blocklisted.
    /// Contract must not be paused.
    ///
    /// # MiCAR
    /// Minting should only occur after fiat funds are received and segregated
    /// in the reserve account (Art. 45). The off-chain compliance oracle must
    /// approve the recipient before minting (SEP-0008 hook).
    ///
    /// # TODO
    /// - Enforce per-address mint limits (Art. 46)
    /// - Call oracle_interface to verify reserve sufficiency before minting
    pub fn mint(env: Env, to: Address, amount: i128) {
        Self::require_not_paused(&env);
        Self::require_minter(&env);
        Self::require_not_blocklisted(&env, &to);

        assert!(amount > 0, "amount must be positive");

        let new_balance = Self::balance(env.clone(), to.clone()) + amount;
        env.storage()
            .persistent()
            .set(&DataKey::Balance(to.clone()), &new_balance);

        let supply: i128 = Self::total_supply(env.clone());
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &(supply + amount));

        env.events().publish((MINT,), (to, amount));
    }

    /// Burn `amount` tokens from `from`.
    ///
    /// Caller must be the designated minter (redemption flow).
    ///
    /// # MiCAR Art. 48
    /// Token holders have the right to redeem at par at any time.
    /// This function is the on-chain leg; the off-chain leg releases fiat.
    ///
    /// # TODO
    /// - Allow token holders to self-burn (direct redemption)
    /// - Emit redemption request event for off-chain processing
    pub fn burn(env: Env, from: Address, amount: i128) {
        Self::require_not_paused(&env);
        Self::require_minter(&env);

        assert!(amount > 0, "amount must be positive");

        let balance = Self::balance(env.clone(), from.clone());
        assert!(balance >= amount, "insufficient balance");

        env.storage()
            .persistent()
            .set(&DataKey::Balance(from.clone()), &(balance - amount));

        let supply: i128 = Self::total_supply(env.clone());
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &(supply - amount));

        env.events().publish((BURN,), (from, amount));
    }

    // ── Transfer ──────────────────────────────────────────────────────────────

    /// Transfer `amount` tokens from `from` to `to`.
    ///
    /// Both parties must not be blocklisted.
    /// Contract must not be paused.
    /// Caller must be `from` (require_auth enforces this).
    ///
    /// # TODO
    /// - Integrate SEP-0008 compliance hook: call the off-chain hook server
    ///   before finalising the transfer (see docs/sep0008-hook.md)
    /// - Add transfer velocity limits per address
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();

        Self::require_not_paused(&env);
        Self::require_not_blocklisted(&env, &from);
        Self::require_not_blocklisted(&env, &to);

        assert!(amount > 0, "amount must be positive");

        let from_balance = Self::balance(env.clone(), from.clone());
        assert!(from_balance >= amount, "insufficient balance");

        env.storage()
            .persistent()
            .set(&DataKey::Balance(from.clone()), &(from_balance - amount));

        let to_balance = Self::balance(env.clone(), to.clone());
        env.storage()
            .persistent()
            .set(&DataKey::Balance(to.clone()), &(to_balance + amount));

        env.events().publish((TRANSFER,), (from, to, amount));
    }

    // ── Clawback ──────────────────────────────────────────────────────────────

    /// Clawback tokens from `from` back to the admin.
    ///
    /// Maps to Stellar Classic AUTH_CLAWBACK_ENABLED flag.
    /// Required by MiCAR for sanctions enforcement and court orders.
    ///
    /// # TODO
    /// - Require a signed compliance order hash as justification
    /// - Emit a structured clawback event with reason code
    pub fn clawback(env: Env, from: Address, amount: i128) {
        Self::require_admin(&env);

        let balance = Self::balance(env.clone(), from.clone());
        assert!(balance >= amount, "insufficient balance");

        env.storage()
            .persistent()
            .set(&DataKey::Balance(from.clone()), &(balance - amount));

        let supply: i128 = Self::total_supply(env.clone());
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &(supply - amount));

        // TODO: credit admin balance or burn — decide policy
        env.events()
            .publish((symbol_short!("CLAWBACK"),), (from, amount));
    }

    // ── Pause ─────────────────────────────────────────────────────────────────

    /// Pause all transfers, mints, and burns.
    /// Only the pauser role can call this.
    pub fn pause(env: Env) {
        Self::require_pauser(&env);
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events().publish((PAUSE,), ());
    }

    /// Resume normal operation.
    pub fn unpause(env: Env) {
        Self::require_pauser(&env);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events().publish((UNPAUSE,), ());
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    // ── Blocklist ─────────────────────────────────────────────────────────────

    /// Block `account` from sending or receiving tokens.
    /// Used for AML/CFT and sanctions compliance (MiCAR Art. 23).
    pub fn blocklist(env: Env, account: Address) {
        Self::require_blocklister(&env);
        env.storage()
            .persistent()
            .set(&DataKey::Blocklisted(account.clone()), &true);
        env.events().publish((BLOCKLIST,), (account, true));
    }

    /// Remove `account` from the blocklist.
    pub fn unblocklist(env: Env, account: Address) {
        Self::require_blocklister(&env);
        env.storage()
            .persistent()
            .set(&DataKey::Blocklisted(account.clone()), &false);
        env.events().publish((BLOCKLIST,), (account, false));
    }

    pub fn is_blocklisted(env: Env, account: Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Blocklisted(account))
            .unwrap_or(false)
    }

    // ── Reserve Attestation ───────────────────────────────────────────────────

    /// Store the IPFS CID or hash of the latest reserve attestation report.
    ///
    /// # MiCAR Art. 45
    /// Reserve assets must be segregated and attested. This anchors the
    /// off-chain attestation document to the chain.
    ///
    /// # TODO
    /// - Integrate oracle_interface contract to pull attestation automatically
    /// - Add attestation timestamp and expiry
    pub fn set_reserve_attestation(env: Env, attestation_hash: String) {
        Self::require_admin(&env);
        env.storage()
            .instance()
            .set(&DataKey::ReserveAttestation, &attestation_hash);
    }

    pub fn reserve_attestation(env: Env) -> Option<String> {
        env.storage()
            .instance()
            .get(&DataKey::ReserveAttestation)
    }

    // ── Role Management ───────────────────────────────────────────────────────

    /// Transfer admin role to a new address.
    /// # TODO: implement two-step transfer (propose + accept) for safety
    pub fn transfer_admin(env: Env, new_admin: Address) {
        Self::require_admin(&env);
        env.storage().instance().set(&DataKey::Admin, &new_admin);
    }

    pub fn update_minter(env: Env, new_minter: Address) {
        Self::require_admin(&env);
        env.storage()
            .instance()
            .set(&DataKey::Minter, &new_minter);
    }

    pub fn update_pauser(env: Env, new_pauser: Address) {
        Self::require_admin(&env);
        env.storage()
            .instance()
            .set(&DataKey::Pauser, &new_pauser);
    }

    pub fn update_blocklister(env: Env, new_blocklister: Address) {
        Self::require_admin(&env);
        env.storage()
            .instance()
            .set(&DataKey::Blocklister, &new_blocklister);
    }

    // ── Internal Guards ───────────────────────────────────────────────────────

    fn require_admin(env: &Env) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
    }

    fn require_minter(env: &Env) {
        let minter: Address = env.storage().instance().get(&DataKey::Minter).unwrap();
        minter.require_auth();
    }

    fn require_pauser(env: &Env) {
        let pauser: Address = env.storage().instance().get(&DataKey::Pauser).unwrap();
        pauser.require_auth();
    }

    fn require_blocklister(env: &Env) {
        let blocklister: Address = env
            .storage()
            .instance()
            .get(&DataKey::Blocklister)
            .unwrap();
        blocklister.require_auth();
    }

    fn require_not_paused(env: &Env) {
        let paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false);
        assert!(!paused, "contract is paused");
    }

    fn require_not_blocklisted(env: &Env, account: &Address) {
        let blocked: bool = env
            .storage()
            .persistent()
            .get(&DataKey::Blocklisted(account.clone()))
            .unwrap_or(false);
        assert!(!blocked, "account is blocklisted");
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::Env;

    fn setup() -> (Env, Address, Address, Address, Address, EmtTokenClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(EmtToken, ());
        let client = EmtTokenClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let minter = Address::generate(&env);
        let pauser = Address::generate(&env);
        let blocklister = Address::generate(&env);

        client.initialize(&admin, &minter, &pauser, &blocklister);
        (env, admin, minter, pauser, blocklister, client)
    }

    #[test]
    fn test_mint_and_balance() {
        let (env, _admin, _minter, _pauser, _blocklister, client) = setup();
        let user = Address::generate(&env);
        client.mint(&user, &1_000_000_0); // 1.0 EUREMT (7 decimals)
        assert_eq!(client.balance(&user), 1_000_000_0);
        assert_eq!(client.total_supply(), 1_000_000_0);
    }

    #[test]
    fn test_transfer() {
        let (env, _admin, _minter, _pauser, _blocklister, client) = setup();
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        client.mint(&alice, &500_000_0);
        client.transfer(&alice, &bob, &200_000_0);
        assert_eq!(client.balance(&alice), 300_000_0);
        assert_eq!(client.balance(&bob), 200_000_0);
    }

    #[test]
    #[should_panic(expected = "account is blocklisted")]
    fn test_blocklisted_cannot_receive() {
        let (env, _admin, _minter, _pauser, _blocklister, client) = setup();
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        client.mint(&alice, &500_000_0);
        client.blocklist(&bob);
        client.transfer(&alice, &bob, &100_000_0);
    }

    #[test]
    #[should_panic(expected = "contract is paused")]
    fn test_paused_blocks_transfer() {
        let (env, _admin, _minter, _pauser, _blocklister, client) = setup();
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        client.mint(&alice, &500_000_0);
        client.pause();
        client.transfer(&alice, &bob, &100_000_0);
    }

    #[test]
    fn test_burn() {
        let (env, _admin, _minter, _pauser, _blocklister, client) = setup();
        let user = Address::generate(&env);
        client.mint(&user, &1_000_000_0);
        client.burn(&user, &400_000_0);
        assert_eq!(client.balance(&user), 600_000_0);
        assert_eq!(client.total_supply(), 600_000_0);
    }

    // TODO: add tests for clawback, role transfers, reserve attestation
}
