# Security Policy

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security bugs.**

Send your report privately to **security@eur-emt.example** (replace with
your team's address before publishing). Reports will be acknowledged
within 3 business days. Critical findings may be eligible for a bug bounty
once a programme is established.

Please include:

- A clear description of the vulnerability and its impact
- Reproduction steps or a minimal proof-of-concept
- Commit hash / branch / Soroban SDK version
- Whether you intend to disclose publicly, and your preferred timeline

## Scope

The following are in scope:

- The three Soroban contracts in `contracts/`
- The TypeScript SDK in `sdk/`
- The deployment scripts in `scripts/`
- Documentation that could lead to insecure deployment guidance
- The companion SEP-0008 hook server (when published)

Out of scope at this time:

- Stellar core protocol vulnerabilities (report to the SDF)
- Off-chain KYC / sanctions provider SDKs mentioned in the docs

## MiCAR-Specific Considerations

This software is **technical infrastructure only**. Issuing EMTs under
MiCAR additionally requires:

1. The issuer to be authorised as an e-money institution or credit
   institution in an EU member state (MiCAR Art. 35).
2. Reserve assets segregated and attested per Art. 45.
3. A real AML/CFT programme run by a designated compliance officer
   (MiCAR Art. 23).

The smart contracts enforce technical controls only; the legal and
operational obligations sit with the issuer.

## Pre-Launch Checklist

Before deploying to **mainnet** with real funds:

- [ ] Full independent security audit (at least one firm, ideally two)
- [ ] Formal verification of the mint/burn/transfer invariants
- [ ] Property-based / fuzz testing for arithmetic, overflow, and authz edges
- [ ] Admin key is a Soroban multisig (≥ 2-of-3, ideally 3-of-5)
- [ ] Minter key is a multisig with daily/weekly limits
- [ ] Pauser key is held by an on-call guardian with documented playbooks
- [ ] Blocklister key is held by a named compliance officer
- [ ] Two-step role handover (propose + accept) — currently single-step
- [ ] Oracle uses M-of-N attestors with off-chain diversity
- [ ] SEP-0008 hook server hardened: TLS, rate limits, audit log,
      reviewed uptime
- [ ] Reserve accounts segregated from issuer operating accounts
- [ ] Bug-bounty programme live
- [ ] Incident response procedures rehearsed

## Hardening Notes

- The contracts use `i128` for amounts; overflow is checked in release
  builds (`overflow-checks = true`).
- Events are emitted for every state transition to support audit
  reconstruction.
- Blocklist is fail-closed: addresses explicitly added are blocked;
  unlisted addresses are fine.
- Approvals (`approve`/`transfer_from`) use single-slot allowances; for
  production consider two-step increase/decrease to mitigate the well-
  known ERC-20 race condition.
