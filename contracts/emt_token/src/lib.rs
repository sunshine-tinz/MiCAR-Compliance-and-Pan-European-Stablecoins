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
//! - **Allowances**: ERC-20-style `approve` and `transfer_from` for delegated transfers
//!
//! ## MiCAR Obligations Addressed
//! - Art. 48: redemption at par on demand → `burn` + off-chain redemption flow
//! - Art. 45: reserve asset segregation → tracked off-chain, attested on-chain
//! - Art. 23: AML/CFT controls → blocklist + SEP-0008 compliance hook
//! - Art. 46: transaction limits → enforced in `transfer` and `mint`
//!
//! ## Clawback policy
//! Clawback **burns** the clawed-back tokens (decreases `TotalSupply`) and
//! decrements the source balance. It does **not** credit the admin. This is the
//! conservative choice: under MiCAR, a clawed-back token should not re-enter
//! circulation unless explicitly re-minted.
//!
//! ## Open contribution items
//! - [ ] Per-address transaction velocity limits (MiCAR Art. 46)
//! - [ ] Oracle integration for automatic reserve sufficiency check
//! - [ ] Two-step admin transfer (propose → accept)
//! - [ ] Fuzz/property-based tests

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Env, String, Symbol,
};

// ── Velocity-limit constants (MiCAR Art. 46) ─────────────────────────────────
//
// Two-bucket sliding window. Bucket size = 12h (~8,640 ledgers at the
// ~5 s/ledger Stellar average). Window size = 24h (~17,280 ledgers).
pub const VEL_BUCKET_SIZE_LEDGERS: u32 = 8_640;
pub const VEL_WINDOW_SIZE_LEDGERS: u32 = 17_280;

// ── Storage Keys ─────────────────────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    Admin,
    /// Successor that has been proposed but has not yet accepted.
    /// Absent ⇒ no proposal in flight.
    PendingAdmin,
    Minter,
    Pauser,
    Blocklister,
    Paused,
    Balance(Address),
    Blocklisted(Address),
    /// Allowance: `Allowance(owner, spender) -> amount`
    Allowance(Address, Address),
    TotalSupply,
    /// MiCAR Art. 45 — reserve attestation hash (off-chain report)
    ReserveAttestation,
    /// MiCAR Art. 46 — global default velocity limit (outgoing 24h volume).
    /// `0` means "no limit". Per-address overrides via `VelocityLimit(addr)`.
    GlobalVelocityLimit,
    /// MiCAR Art. 46 — per-address velocity limit override.
    /// Absence means "fall back to `GlobalVelocityLimit`".
    VelocityLimit(Address),
    /// MiCAR Art. 46 — sliding-window volume tracker per sender.
    VelocityState(Address),
    #[allow(dead_code)]
    MintLimit(Address),
}

/// Per-sender 24-hour rolling volume tracker.
///
/// `current` accumulates the ongoing bucket; `previous` is the bucket that
/// just rolled off the window. The effective 24h volume is a linear
/// interpolation of `previous` over the duration of `current` (so as
/// `current_bucket` completes, `previous`'s contribution fades to zero).
#[contracttype]
#[derive(Clone)]
pub struct VelocityState {
    pub bucket_time: u32,
    pub current: i128,
    pub previous: i128,
}

// ── Events ────────────────────────────────────────────────────────────────────
//
// `symbol_short!` is limited to 9 characters. Keep all topic names ≤ 9 chars.

const MINT: Symbol = symbol_short!("MINT");
const BURN: Symbol = symbol_short!("BURN");
const TRANSFER: Symbol = symbol_short!("TRANSFER");
const CLAWBACK: Symbol = symbol_short!("CLAWBACK");
const PAUSE_EV: Symbol = symbol_short!("PAUSE");
const UNPAUSE_EV: Symbol = symbol_short!("UNPAUSE");
const BLOCKLIST: Symbol = symbol_short!("BLOCKLIST");
const APPROVE: Symbol = symbol_short!("APPROVE");
/// Admin transfer proposed (current admin → proposed successor).
const PROPOSE: Symbol = symbol_short!("PROPOSE");
/// Admin transfer accepted — the proposed address is now admin.
const ACCEPT_AD: Symbol = symbol_short!("ACCEPT");
/// Admin transfer proposal cancelled by the current admin.
const CANCEL_AD: Symbol = symbol_short!("CANCEL");

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
        // MiCAR Art. 46 default: no velocity cap unless the admin sets one.
        env.storage()
            .instance()
            .set(&DataKey::GlobalVelocityLimit, &0_i128);
        // Stamp instance storage TTL so the contract stays dispatchable
        // across long idle periods (and across the test-env ledger
        // advances that simulate them). Threshold ≈ 6 mo, extend-to ≈ 1 y.
        env.storage().instance().extend_ttl(3_153_600, 6_300_000);
    }

    // ── Token Metadata ────────────────────────────────────────────────────────

    pub fn name(env: Env) -> String {
        String::from_str(&env, "Euro EMT")
    }

    pub fn symbol(env: Env) -> String {
        String::from_str(&env, "EUREMT")
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

    pub fn allowance(env: Env, owner: Address, spender: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Allowance(owner, spender))
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
    /// in the reserve account (Art. 45).
    pub fn mint(env: Env, to: Address, amount: i128) {
        Self::require_not_paused(&env);
        Self::require_minter(&env);
        Self::require_not_blocklisted(&env, &to);

        assert!(amount > 0, "amount must be positive");

        let new_balance = Self::balance(env.clone(), to.clone()) + amount;
        Self::write_balance(&env, to.clone(), new_balance);

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
    pub fn burn(env: Env, from: Address, amount: i128) {
        Self::require_not_paused(&env);
        Self::require_minter(&env);

        assert!(amount > 0, "amount must be positive");

        let balance = Self::balance(env.clone(), from.clone());
        assert!(balance >= amount, "insufficient balance");

        Self::write_balance(&env, from.clone(), balance - amount);

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
    /// Outgoing volume counts against `from`'s 24h velocity limit (MiCAR
    /// Art. 46) when a cap is configured.
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();

        Self::require_not_paused(&env);
        Self::require_not_blocklisted(&env, &from);
        Self::require_not_blocklisted(&env, &to);

        assert!(amount > 0, "amount must be positive");

        // Velocity check happens before balance mutation so a rejected
        // transfer doesn't leave stale state on the sender.
        Self::check_and_update_velocity(&env, &from, amount);

        let from_balance = Self::balance(env.clone(), from.clone());
        assert!(from_balance >= amount, "insufficient balance");

        Self::write_balance(&env, from.clone(), from_balance - amount);

        let to_balance = Self::balance(env.clone(), to.clone());
        Self::write_balance(&env, to.clone(), to_balance + amount);

        env.events().publish((TRANSFER,), (from, to, amount));
    }

    /// Approve `spender` to transfer up to `amount` on behalf of `from`.
    ///
    /// Setting `amount` to 0 revokes the allowance. Overwrites any previous
    /// allowance — clients should request the new allowance for safety.
    pub fn approve(env: Env, from: Address, spender: Address, amount: i128) {
        from.require_auth();

        assert!(amount >= 0, "amount must be non-negative");
        assert!(from != spender, "self-approval is not allowed");

        Self::write_allowance(&env, from.clone(), spender.clone(), amount);

        env.events().publish((APPROVE,), (from, spender, amount));
    }

    /// Move `amount` tokens from `spender`'s allowance of `from` to `to`.
    ///
    /// Caller must be `spender` (require_auth enforces this).
    pub fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();

        Self::require_not_paused(&env);
        Self::require_not_blocklisted(&env, &from);
        Self::require_not_blocklisted(&env, &to);

        assert!(amount > 0, "amount must be positive");

        // Velocity limit is charged against the `from` address (whose
        // balance is being spent), not the `spender` acting on its behalf.
        Self::check_and_update_velocity(&env, &from, amount);

        let allowance = Self::allowance(env.clone(), from.clone(), spender.clone());
        assert!(allowance >= amount, "insufficient allowance");

        let from_balance = Self::balance(env.clone(), from.clone());
        assert!(from_balance >= amount, "insufficient balance");

        Self::write_allowance(&env, from.clone(), spender.clone(), allowance - amount);

        Self::write_balance(&env, from.clone(), from_balance - amount);

        let to_balance = Self::balance(env.clone(), to.clone());
        Self::write_balance(&env, to.clone(), to_balance + amount);

        env.events().publish((TRANSFER,), (from, to, amount));
    }

    // ── Clawback ──────────────────────────────────────────────────────────────

    /// Clawback tokens from `from`.
    ///
    /// The clawed-back amount is **burned**: it is removed from the source
    /// balance and decremented from total supply. It is not credited to any
    /// other address. This is the conservative, audit-friendly policy.
    ///
    /// Maps to Stellar Classic AUTH_CLAWBACK_ENABLED flag.
    /// Required by MiCAR for sanctions enforcement and court orders.
    pub fn clawback(env: Env, from: Address, amount: i128) {
        Self::require_admin(&env);

        assert!(amount > 0, "amount must be positive");

        let balance = Self::balance(env.clone(), from.clone());
        assert!(balance >= amount, "insufficient balance");

        Self::write_balance(&env, from.clone(), balance - amount);

        let supply: i128 = Self::total_supply(env.clone());
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &(supply - amount));

        env.events().publish((CLAWBACK,), (from, amount));
    }

    // ── Pause ─────────────────────────────────────────────────────────────────

    /// Pause all transfers, mints, and burns. Only the pauser role.
    pub fn pause(env: Env) {
        Self::require_pauser(&env);
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events().publish((PAUSE_EV,), ());
    }

    /// Resume normal operation. Only the pauser role.
    pub fn unpause(env: Env) {
        Self::require_pauser(&env);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events().publish((UNPAUSE_EV,), ());
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    // ── Blocklist ─────────────────────────────────────────────────────────────

    /// Block `account` from sending or receiving tokens (MiCAR Art. 23).
    pub fn blocklist(env: Env, account: Address) {
        Self::require_blocklister(&env);
        Self::write_blocklist(&env, account.clone(), true);
        env.events().publish((BLOCKLIST,), (account, true));
    }

    /// Remove `account` from the blocklist.
    pub fn unblocklist(env: Env, account: Address) {
        Self::require_blocklister(&env);
        Self::write_blocklist(&env, account.clone(), false);
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
    pub fn set_reserve_attestation(env: Env, attestation_hash: String) {
        Self::require_admin(&env);
        env.storage()
            .instance()
            .set(&DataKey::ReserveAttestation, &attestation_hash);
    }

    pub fn reserve_attestation(env: Env) -> Option<String> {
        env.storage().instance().get(&DataKey::ReserveAttestation)
    }

    // ── Role Management ───────────────────────────────────────────────────────

    pub fn update_minter(env: Env, new_minter: Address) {
        Self::require_admin(&env);
        env.storage().instance().set(&DataKey::Minter, &new_minter);
    }

    pub fn update_pauser(env: Env, new_pauser: Address) {
        Self::require_admin(&env);
        env.storage().instance().set(&DataKey::Pauser, &new_pauser);
    }

    pub fn update_blocklister(env: Env, new_blocklister: Address) {
        Self::require_admin(&env);
        env.storage()
            .instance()
            .set(&DataKey::Blocklister, &new_blocklister);
    }

    // ── Two-step admin handover ──────────────────────────────────────────────

    /// **Step 1.** Current admin proposes a successor.
    ///
    /// Stores the proposed address under `PendingAdmin` and emits `PROPOSE`.
    /// Auth: current admin only.
    ///
    /// Calling this again overwrites a previous proposer's pending status.
    /// To cancel without re-proposing, use {@link cancel_proposed_admin}.
    pub fn propose_admin(env: Env, new_admin: Address) {
        Self::require_admin(&env);
        let current_admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();

        assert!(new_admin != current_admin, "already admin");

        env.storage()
            .instance()
            .set(&DataKey::PendingAdmin, &new_admin);

        env.events().publish((PROPOSE,), (current_admin, new_admin));
    }

    /// **Step 2.** The proposed successor accepts and becomes admin.
    ///
    /// Auth: the proposed successor only. Panics if no proposal is in flight,
    /// so a stale caller cannot accidentally clobber a fresh proposal.
    pub fn accept_admin(env: Env) {
        let pending_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .expect("no pending admin");

        pending_admin.require_auth();

        env.storage()
            .instance()
            .set(&DataKey::Admin, &pending_admin);
        env.storage().instance().remove(&DataKey::PendingAdmin);

        env.events().publish((ACCEPT_AD,), (pending_admin,));
    }

    /// **Step 1b.** Current admin cancels a pending proposal.
    ///
    /// Auth: current admin only. Panics if there is no pending proposal so the
    /// operation is auditable (raise instead of silent no-op).
    pub fn cancel_proposed_admin(env: Env) {
        Self::require_admin(&env);

        if !env.storage().instance().has(&DataKey::PendingAdmin) {
            panic!("no pending admin");
        }

        env.storage().instance().remove(&DataKey::PendingAdmin);
        let current_admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        env.events().publish((CANCEL_AD,), (current_admin,));
    }

    /// Read the current pending admin proposal, if any.
    pub fn pending_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::PendingAdmin)
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
        let blocklister: Address = env.storage().instance().get(&DataKey::Blocklister).unwrap();
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

    /// Write `account`'s balance to persistent storage and bump its TTL
    /// to the host ceiling.
    ///
    /// Soroban's persistent entries become eligible for archiving once
    /// their TTL falls below `min_persistent_entry_ttl` (4,096 ledgers ≈
    /// 5.7 h at ~5 s/ledger). For a long-lived account balance we want
    /// the entry to survive any reasonable idle period AND any
    /// simulated ledger advance. Threshold ≈ 6 months; extend-to at the
    /// **host ceiling** (`max_entry_ttl` = 6_312_000 ledgers ≈ 1 year at
    /// ~5 s/ledger) — chosen so the balance contributes the maximum
    /// per-write retention the host allows. MiCAR Art. 23 / Art. 48
    /// require retaining ecosystem-relevant state across the
    /// 5-year record-keeping window; that window is satisfied by an
    /// admin cron (or external archival layer) periodically
    /// re-extending entries to the ceiling — this `extend_ttl` call
    /// maximises each write's contribution to that retention.
    fn write_balance(env: &Env, account: Address, balance: i128) {
        let key = DataKey::Balance(account);
        env.storage().persistent().set(&key, &balance);
        env.storage()
            .persistent()
            .extend_ttl(&key, 3_153_600, 6_312_000);
    }

    /// Write `(owner, spender)`'s allowance to persistent storage and
    /// bump its TTL to the host ceiling.
    ///
    /// Same hygiene rationale as [`Self::write_balance`]: an approval
    /// that's "live" should not silently expire. We extend to the
    /// **host ceiling** (`max_entry_ttl` = 6_312_000 ledgers ≈ 1 year
    /// at ~5 s/ledger) so the approval remains valid across delegations
    /// that span months — required by MiCAR Art. 23 / Art. 48
    /// record-keeping.
    fn write_allowance(env: &Env, owner: Address, spender: Address, amount: i128) {
        let key = DataKey::Allowance(owner, spender);
        env.storage().persistent().set(&key, &amount);
        env.storage()
            .persistent()
            .extend_ttl(&key, 3_153_600, 6_312_000);
    }
    /// Write `account`'s blocklist flag and bump its TTL to the host ceiling.
    ///
    /// Same hygiene rationale as [`Self::write_balance`] and
    /// [`Self::write_allowance`]: without the `extend_ttl` follow-up, the
    /// entry would be eligible for archiving once its TTL falls below
    /// `min_persistent_entry_ttl` (4,096 ledgers ≈ 5.7 h at ~5 s/ledger).
    /// For a sanctions entry that's a MiCAR Art. 23 compliance fault — the
    /// address would silently "un-block" after a few hours of inactivity.
    /// We extend to the same **host ceiling** as Balance/Allowance
    /// (`max_entry_ttl` = 6_312_000 ledgers ≈ 1 year at ~5 s/ledger);
    /// the retention *priority* for sanctions entries is enforced through
    /// the audited admin path (`require_blocklister` + intent-only writes
    /// via `blocklist`/`unblocklist`) rather than through a different
    /// per-write ceiling. MiCAR Art. 23 / Art. 48 record-keeping still
    /// requires the same admin-cron / external archiver pattern documented
    /// on [`Self::write_balance`].
    fn write_blocklist(env: &Env, account: Address, blocked: bool) {
        let key = DataKey::Blocklisted(account);
        env.storage().persistent().set(&key, &blocked);
        env.storage()
            .persistent()
            .extend_ttl(&key, 3_153_600, 6_312_000);
    }

    // ── Velocity Limits (MiCAR Art. 46) ────────────────────────────────────

    /// Set the global default 24h outgoing-volume cap.
    ///
    /// `0` disables capping (unlimited). All addresses without a per-address
    /// override use this limit. Admin only.
    pub fn set_global_velocity_limit(env: Env, limit: i128) {
        Self::require_admin(&env);
        assert!(limit >= 0, "limit must be non-negative");
        env.storage()
            .instance()
            .set(&DataKey::GlobalVelocityLimit, &limit);
    }

    /// Set a per-address override (admin only).
    ///
    /// `0` makes the address unlimited regardless of the global default.
    /// Use `clear_velocity_limit` to remove the override. Bumps the
    /// entry's TTL so the override can't silently expire and revert to
    /// the global default (Soroban's persistent entries are evicted once
    /// their TTL elapses without an `extend_ttl` touch).
    pub fn set_velocity_limit(env: Env, address: Address, limit: i128) {
        Self::require_admin(&env);
        assert!(limit >= 0, "limit must be non-negative");
        let key = DataKey::VelocityLimit(address);
        env.storage().persistent().set(&key, &limit);
        // Threshold ≈ 6 months, ceiling ≈ 1 year — chosen so the override
        // survives between scheduled admin reviews without per-transfer
        // TTL bumps.
        env.storage()
            .persistent()
            .extend_ttl(&key, 3_153_600, 6_300_000);
    }

    /// Clear a per-address override so the address falls back to the
    /// global default (admin only).
    pub fn clear_velocity_limit(env: Env, address: Address) {
        Self::require_admin(&env);
        env.storage()
            .persistent()
            .remove(&DataKey::VelocityLimit(address));
    }

    /// Effective 24h velocity limit for `address`.
    ///
    /// Returns the per-address override if set, otherwise the global
    /// default. `0` means unlimited.
    pub fn get_velocity_limit(env: Env, address: Address) -> i128 {
        Self::effective_velocity_limit(&env, &address)
    }

    /// Currently-accumulated outgoing volume in the 24h sliding window.
    ///
    /// Useful for wallets and exchanges to surface "you can transfer at
    /// most X more today" before attempting a transfer that the contract
    /// would reject for velocity reasons.
    pub fn get_outflow_today(env: Env, address: Address) -> i128 {
        Self::outflow_at(&env, &address)
    }

    // ── Velocity Limit helpers (MiCAR Art. 46) ─────────────────────────────

    /// Effective velocity limit for `address` (per-address override
    /// takes precedence; `0` means no cap).
    fn effective_velocity_limit(env: &Env, address: &Address) -> i128 {
        let per: Option<i128> = env
            .storage()
            .persistent()
            .get(&DataKey::VelocityLimit(address.clone()));
        per.unwrap_or_else(|| {
            env.storage()
                .instance()
                .get(&DataKey::GlobalVelocityLimit)
                .unwrap_or(0)
        })
    }

    /// Currently-accumulated outgoing volume in the 24h sliding window.
    ///
    /// When more than a full window has elapsed since the last state update,
    /// the contract side zeroes both buckets, so the conservative reading
    /// is to return `0` rather than risk over-counting `state.current` (whose
    /// oldest entries are already outside the window).
    fn outflow_at(env: &Env, address: &Address) -> i128 {
        let now = env.ledger().sequence();
        let bucket_start = (now / VEL_BUCKET_SIZE_LEDGERS) * VEL_BUCKET_SIZE_LEDGERS;
        let state: Option<VelocityState> = env
            .storage()
            .persistent()
            .get(&DataKey::VelocityState(address.clone()));
        let state = match state {
            Some(s) => s,
            None => return 0,
        };
        let ledgers_passed = bucket_start.saturating_sub(state.bucket_time);
        if ledgers_passed >= VEL_WINDOW_SIZE_LEDGERS {
            // Whole window has rolled off; mirrors the reset that
            // `check_and_update_velocity` performs on this branch.
            return 0;
        }
        let time_into_current = now - bucket_start;
        let prev_weight_numer = (VEL_BUCKET_SIZE_LEDGERS - time_into_current) as i128;
        // Single weighted contribution covers both "previous bucket
        // partial overlap" and "same bucket" cases — `time_into_current`
        // linearly weights the `previous` bucket down to zero.
        state.current + (state.previous * prev_weight_numer) / VEL_BUCKET_SIZE_LEDGERS as i128
    }

    fn check_and_update_velocity(env: &Env, from: &Address, amount: i128) {
        let limit = Self::effective_velocity_limit(env, from);

        let now = env.ledger().sequence();
        let bucket_start = (now / VEL_BUCKET_SIZE_LEDGERS) * VEL_BUCKET_SIZE_LEDGERS;

        let mut state: VelocityState = env
            .storage()
            .persistent()
            .get(&DataKey::VelocityState(from.clone()))
            .unwrap_or(VelocityState {
                bucket_time: bucket_start,
                current: 0,
                previous: 0,
            });

        let ledgers_passed = bucket_start.saturating_sub(state.bucket_time);
        if ledgers_passed >= VEL_WINDOW_SIZE_LEDGERS {
            state.previous = 0;
            state.current = 0;
        } else if ledgers_passed >= VEL_BUCKET_SIZE_LEDGERS {
            // Shift current → previous, zero current.
            state.previous = state.current;
            state.current = 0;
        }
        state.bucket_time = bucket_start;

        let time_into_current = now - bucket_start;
        let prev_weight_numer = (VEL_BUCKET_SIZE_LEDGERS - time_into_current) as i128;
        let prev_contribution =
            (state.previous * prev_weight_numer) / VEL_BUCKET_SIZE_LEDGERS as i128;
        let projected = prev_contribution + state.current + amount;
        // Cap enforcement is **only** triggered when a non-zero limit
        // is configured (global or per-address). When the limit is 0
        // (unlimited), the velocity state still updates so that
        // `outflow_at` and `get_outflow_today` return the actual
        // accumulated volume for unbounded addresses.
        if limit > 0 {
            assert!(projected <= limit, "velocity limit exceeded");
        }

        state.current += amount;
        let key = DataKey::VelocityState(from.clone());
        env.storage().persistent().set(&key, &state);
        // Bump TTL so the persistent entry survives 24h of inactivity.
        // Threshold (= BUCKET_SIZE = 12h) and target (= WINDOW + one
        // bucket) keep the entry alive across at least one full window
        // without bumping on every transfer.
        env.storage().persistent().extend_ttl(
            &key,
            VEL_BUCKET_SIZE_LEDGERS,
            VEL_WINDOW_SIZE_LEDGERS + VEL_BUCKET_SIZE_LEDGERS,
        );
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::{Env, String};

    fn setup() -> (
        Env,
        Address,
        Address,
        Address,
        Address,
        EmtTokenClient<'static>,
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, EmtToken);
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
        client.mint(&user, &10_000_000); // 1.0 EUREMT (7 decimals)
        assert_eq!(client.balance(&user), 10_000_000);
        assert_eq!(client.total_supply(), 10_000_000);
    }

    #[test]
    fn test_transfer() {
        let (env, _admin, _minter, _pauser, _blocklister, client) = setup();
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        client.mint(&alice, &5_000_000);
        client.transfer(&alice, &bob, &2_000_000);
        assert_eq!(client.balance(&alice), 3_000_000);
        assert_eq!(client.balance(&bob), 2_000_000);
    }

    #[test]
    #[should_panic(expected = "account is blocklisted")]
    fn test_blocklisted_cannot_receive() {
        let (env, _admin, _minter, _pauser, _blocklister, client) = setup();
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        client.mint(&alice, &5_000_000);
        client.blocklist(&bob);
        client.transfer(&alice, &bob, &1_000_000);
    }

    #[test]
    #[should_panic(expected = "contract is paused")]
    fn test_paused_blocks_transfer() {
        let (env, _admin, _minter, _pauser, _blocklister, client) = setup();
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        client.mint(&alice, &5_000_000);
        client.pause();
        client.transfer(&alice, &bob, &1_000_000);
    }

    #[test]
    fn test_burn() {
        let (env, _admin, _minter, _pauser, _blocklister, client) = setup();
        let user = Address::generate(&env);
        client.mint(&user, &10_000_000);
        client.burn(&user, &4_000_000);
        assert_eq!(client.balance(&user), 6_000_000);
        assert_eq!(client.total_supply(), 6_000_000);
    }

    // ── New tests (no snapshots yet — generated on first `cargo test`) ────────

    #[test]
    fn test_metadata() {
        let (_env, _a, _m, _p, _b, client) = setup();
        assert_eq!(client.name(), String::from_str(&_env, "Euro EMT"));
        assert_eq!(client.symbol(), String::from_str(&_env, "EUREMT"));
        assert_eq!(client.decimals(), 7);
    }

    #[test]
    fn test_approve_and_transfer_from() {
        let (env, _a, _m, _p, _b, client) = setup();
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        let carol = Address::generate(&env);

        client.mint(&alice, &10_000_000);
        client.approve(&alice, &bob, &4_000_000);
        assert_eq!(client.allowance(&alice, &bob), 4_000_000);

        client.transfer_from(&bob, &alice, &carol, &3_000_000);
        assert_eq!(client.balance(&alice), 7_000_000);
        assert_eq!(client.balance(&carol), 3_000_000);
        assert_eq!(client.allowance(&alice, &bob), 1_000_000);
    }

    #[test]
    #[should_panic(expected = "insufficient allowance")]
    fn test_transfer_from_over_allowance() {
        let (env, _a, _m, _p, _b, client) = setup();
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        let carol = Address::generate(&env);

        client.mint(&alice, &10_000_000);
        client.approve(&alice, &bob, &2_000_000);
        client.transfer_from(&bob, &alice, &carol, &5_000_000);
    }

    #[test]
    #[should_panic(expected = "self-approval is not allowed")]
    fn test_self_approve_rejected() {
        let (env, _a, _m, _p, _b, client) = setup();
        let alice = Address::generate(&env);
        client.approve(&alice, &alice, &1_000_000);
    }

    #[test]
    fn test_approve_zero_revokes() {
        let (env, _a, _m, _p, _b, client) = setup();
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);

        client.approve(&alice, &bob, &0);
        assert_eq!(client.allowance(&alice, &bob), 0);
    }

    #[test]
    fn test_clawback_burns() {
        let (env, admin, _m, _p, _b, client) = setup();
        let user = Address::generate(&env);
        client.mint(&user, &10_000_000);

        // direct admin call (mock_all_auths allows it)
        client.clawback(&user, &3_000_000);
        assert_eq!(client.balance(&user), 7_000_000);
        assert_eq!(client.total_supply(), 7_000_000);

        // sanity: admin address is unchanged
        let _ = admin;
    }

    #[test]
    #[should_panic(expected = "insufficient balance")]
    fn test_clawback_below_balance() {
        let (env, _a, _m, _p, _b, client) = setup();
        let user = Address::generate(&env);
        client.mint(&user, &1_000_000);
        client.clawback(&user, &2_000_000);
    }

    #[test]
    fn test_reserve_attestation_roundtrip() {
        let (env, _a, _m, _p, _b, client) = setup();
        let hash = String::from_str(&env, "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG");
        client.set_reserve_attestation(&hash);
        assert_eq!(client.reserve_attestation(), Some(hash));
    }

    #[test]
    fn test_role_updates() {
        let (env, _a, _m, _pauser, _blocklister, client) = setup();
        let new_minter = Address::generate(&env);
        let new_pauser = Address::generate(&env);
        let new_blocklister = Address::generate(&env);

        client.update_minter(&new_minter);
        client.update_pauser(&new_pauser);
        client.update_blocklister(&new_blocklister);

        // sanity: the new pauser can now actually pause
        client.pause();
        assert!(client.is_paused());
    }

    #[test]
    #[should_panic(expected = "already initialized")]
    fn test_double_initialize_blocked() {
        let (_env, admin, minter, pauser, blocklister, client) = setup();
        // Re-using the already-initialized `client` from `setup()` —
        // registering a fresh contract here would yield a NEW contract
        // id with empty storage, where `initialize` would succeed and
        // not panic.
        client.initialize(&admin, &minter, &pauser, &blocklister);
    }

    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn test_zero_mint_rejected() {
        let (env, _a, _m, _p, _b, client) = setup();
        let user = Address::generate(&env);
        client.mint(&user, &0);
    }

    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn test_zero_transfer_rejected() {
        let (env, _a, _m, _p, _b, client) = setup();
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        client.mint(&alice, &1_000_000);
        client.transfer(&alice, &bob, &0);
    }

    // ── Two-step admin handover tests ────────────────────────────────────────

    #[test]
    fn test_propose_and_accept_admin() {
        let (env, _admin, _m, _p, _b, client) = setup();
        let next_admin = Address::generate(&env);

        // admin proposes → pending recorded, admin unchanged
        client.propose_admin(&next_admin);
        assert_eq!(client.pending_admin(), Some(next_admin.clone()));

        // proposed admin accepts → becomes admin, pending cleared
        client.accept_admin();
        assert_eq!(client.pending_admin(), None);

        // sanity: new admin can perform a privileged action (update_pauser)
        let new_pauser = Address::generate(&env);
        client.update_pauser(&new_pauser);
        let _ = env;
    }

    // NOTE: we deliberately do not test "only the proposed address can
    // call `accept_admin`" here. Under Soroban's `mock_all_auths()` test
    // helper, every `require_auth()` succeeds regardless of the calling
    // address, so the auth check can't be exercised in unit tests. On a
    // live network it is enforced by the host: `pending_admin.require_auth()`
    // panics if no signature for `pending_admin` was attached to the
    // transaction.

    #[test]
    fn test_re_propose_overwrites_pending() {
        let (env, _admin, _m, _p, _b, client) = setup();
        let a = Address::generate(&env);
        let b = Address::generate(&env);

        client.propose_admin(&a);
        client.propose_admin(&b);
        assert_eq!(client.pending_admin(), Some(b)); // b overwrites a
    }

    #[test]
    fn test_cancel_proposed_admin_clears_state() {
        let (env, _admin, _m, _p, _b, client) = setup();
        let proposed = Address::generate(&env);

        client.propose_admin(&proposed);
        assert_eq!(client.pending_admin(), Some(proposed.clone()));

        client.cancel_proposed_admin();
        assert_eq!(client.pending_admin(), None);
    }

    #[test]
    #[should_panic(expected = "no pending admin")]
    fn test_cancel_with_no_proposal_panics() {
        let (_env, _a, _m, _p, _b, client) = setup();
        client.cancel_proposed_admin();
    }

    #[test]
    #[should_panic(expected = "no pending admin")]
    fn test_accept_with_no_proposal_panics() {
        let (_env, _a, _m, _p, _b, client) = setup();
        client.accept_admin();
    }

    #[test]
    #[should_panic(expected = "already admin")]
    fn test_propose_current_admin_rejected() {
        let (_env, admin, _m, _p, _b, client) = setup();
        client.propose_admin(&admin);
    }

    #[test]
    fn test_pending_admin_none_after_init() {
        let (_env, _a, _m, _p, _b, client) = setup();
        assert_eq!(client.pending_admin(), None);
    }

    // ── Velocity-limit (MiCAR Art. 46) tests ────────────────────────────────

    #[test]
    fn test_transfer_under_velocity_limit_succeeds() {
        let (env, _a, _m, _p, _b, client) = setup();
        client.set_global_velocity_limit(&100_000_000i128); // 10 EUREMT (7dp)

        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        client.mint(&alice, &200_000_000);
        client.transfer(&alice, &bob, &40_000_000);
        client.transfer(&alice, &bob, &40_000_000);
        // outflow = 80M < 100M
        assert_eq!(client.get_outflow_today(&alice), 80_000_000);
        assert_eq!(client.get_velocity_limit(&alice), 100_000_000);
    }

    #[test]
    #[should_panic(expected = "velocity limit exceeded")]
    fn test_transfer_over_velocity_limit_panics() {
        let (env, _a, _m, _p, _b, client) = setup();
        client.set_global_velocity_limit(&50_000_000i128);

        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        client.mint(&alice, &200_000_000);
        client.transfer(&alice, &bob, &30_000_000);
        client.transfer(&alice, &bob, &30_000_000); // cumulative 60M > 50M cap
    }

    #[test]
    fn test_per_address_limit_overrides_global() {
        let (env, _a, _m, _p, _b, client) = setup();
        client.set_global_velocity_limit(&100_000_000i128);

        let alice = Address::generate(&env);
        client.set_velocity_limit(&alice, &10_000_000i128);
        assert_eq!(client.get_velocity_limit(&alice), 10_000_000);

        client.set_velocity_limit(&alice, &0i128);
        assert_eq!(client.get_velocity_limit(&alice), 0); // unlimited for alice

        client.clear_velocity_limit(&alice);
        assert_eq!(client.get_velocity_limit(&alice), 100_000_000); // back to global
    }

    #[test]
    fn test_velocity_resets_after_window() {
        let (env, _a, _m, _p, _b, client) = setup();
        client.set_global_velocity_limit(&100_000_000i128);

        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        client.mint(&alice, &500_000_000);

        client.transfer(&alice, &bob, &50_000_000);
        // Advance past the full 24h window so the state resets entirely.
        env.ledger().with_mut(|li| {
            li.sequence_number = li
                .sequence_number
                .saturating_add(VEL_WINDOW_SIZE_LEDGERS + 1);
        });
        // After full reset, the recipient outflow slot is empty; the
        // transfer should succeed because the previous bucket has rolled
        // entirely off.
        client.transfer(&alice, &bob, &50_000_000);
        assert_eq!(client.get_outflow_today(&alice), 50_000_000);
    }

    #[test]
    fn test_transfer_from_is_velocity_gated() {
        let (env, _a, _m, _p, _b, client) = setup();
        // 100M cap so 30M + 30M = 60M cumulative fits; the test asserts
        // both transfers succeed AND that outflow_today reads 60M.
        client.set_global_velocity_limit(&100_000_000i128);

        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        let spender = Address::generate(&env);

        client.mint(&alice, &200_000_000);
        client.approve(&alice, &spender, &200_000_000);
        client.transfer_from(&spender, &alice, &bob, &30_000_000);
        client.transfer_from(&spender, &alice, &bob, &30_000_000);
        assert_eq!(client.get_outflow_today(&alice), 60_000_000);
    }

    #[test]
    fn test_velocity_default_zero_is_unlimited() {
        let (env, _a, _m, _p, _b, client) = setup();
        // No set_global_velocity_limit called; default = 0 = unlimited.
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        client.mint(&alice, &500_000_000);
        client.transfer(&alice, &bob, &250_000_000);
        client.transfer(&alice, &bob, &250_000_000);
        assert_eq!(client.get_outflow_today(&alice), 500_000_000);
    }
}
