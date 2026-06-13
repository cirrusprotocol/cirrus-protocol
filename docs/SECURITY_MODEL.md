# Security Model

> **Scope:** This document describes the trust model and security guarantees of the shielded pool alpha as implemented. It is written for reviewers and operators who need to reason about what the on-chain program enforces versus what it delegates to off-chain parties.
>
> This is an **unaudited single-operator devnet alpha**. Claims in this document reflect implementation, not aspirational properties.

---

## 1. System Overview

The protocol mediates withdrawals from a SOL pool. A withdrawal succeeds if and only if:

1. A threshold of authorized Ed25519 keys have signed a commitment to the withdrawal parameters (the handshake hash).
2. The relayer submitting the transaction is the one named in the intent.
3. The nullifier has not been previously consumed.
4. The expiry slot has not passed.
5. The pool's spendable balance (pool lamports minus its own rent-exempt reserve) is ≥ intent.amount.
6. The protocol is not paused.

All six conditions are verified on-chain. The program enforces them deterministically regardless of who calls it.

---

## 2. Verifier Committee Trust Model

> **Terminology note:** "Verifier" here means an Ed25519 key holder who signs the handshake hash off-chain. This is threshold signature verification, not ZK proof verification. "Attestation" means that the on-chain parser counted ≥ threshold unique authorized signatures — not a proof attestation in the ZK circuit sense.

### What the verifiers sign

Verifiers sign the **handshake hash**: a Keccak256 digest of a 196-byte preimage containing:

```
TAG(26) | version(1) | program_id(32) | pool_pda(32) | config_pda(32) |
expiry_slot(8) | audit_hash(32) | intent_hash(32) | policy_id(1)
```

The intent hash is itself a Keccak256 digest of a 248-byte preimage containing all intent fields (recipient, relayer, amount, fee, nonce, chain_id, nullifier, commitment, merkle_root, audit_hash, policy_id).

By signing the handshake hash, a verifier commits to: a specific program and pool PDA, a specific expiry window, the full intent parameters, and the policy_id.

### What the on-chain program checks

The program receives Ed25519 instructions that precede the withdraw instruction in the same transaction. It parses each Ed25519 instruction, extracts the signed message and the signing pubkey, and checks:

- The signed message matches the handshake hash computed from the submitted intent.
- The signing pubkey is in `config.verifier_pubkeys`.
- The same pubkey is not counted twice.

If unique authorized signers ≥ `config.threshold`, attestation passes.

### What the on-chain program does NOT check

The program does not verify what the verifiers decided to sign or why. Specifically:

- It does not verify that `intent.commitment` corresponds to a valid ZK circuit output.
- It does not verify that `intent.merkle_root` is a root of any Merkle tree (though it can optionally enforce that the root is in the admin-managed `allowed_roots` registry — see §3 and `KNOWN_LIMITATIONS.md`).
- It does not verify that `intent.nullifier` is a valid nullifier for the claimed commitment.
- It does not verify that `intent.audit_hash` corresponds to any off-chain record.
- It does not enforce `intent.policy_id` against any allowed set.
- It does not enforce `intent.nonce` sequencing.

**These checks are entirely delegated to the verifier committee.** The on-chain program's security guarantee is: the pool cannot be drained unless a threshold of the configured verifier keys sign a valid handshake hash for that withdrawal. Whether verifiers sign appropriate intents is an off-chain operational responsibility.

### Trust assumption

A threshold of verifier keys can drain the pool. If `t` of `n` verifier keys are compromised or collude, an attacker can construct any valid intent and sign it. There is no on-chain mechanism that limits the total amount a verifier can authorize, restricts the destination address, or enforces any delay.

**Threshold security requires independent key control.** A k-of-n threshold configuration only provides k-party security if the n key holders are genuinely independent — each holding exactly one key, with no other holder having access to it. If one operator controls all n keys, that operator can produce any threshold signature independently; configuring k-of-n does not prevent them from authorizing arbitrary withdrawals using k of their own keys. The threshold only raises the bar against external attackers who must compromise multiple independent parties simultaneously.

For the alpha: all verifier keys are held by the protocol operator. The security model is single-operator regardless of the configured threshold. A deployment with threshold=2-of-3 where one operator holds all three keys is no safer against operator misbehavior than threshold=1-of-1. This is acceptable only for a single-operator devnet alpha and is explicitly not a multi-party trust model.

---

## 3. Threshold Attestation Mechanism

Threshold is `config.threshold` (integer, 1–8). The configured verifier set has at most 8 keys (`MAX_VERIFIERS = 8`).

The on-chain parser (`attestation.rs`) scans all instructions preceding the current withdraw instruction. It accepts only Ed25519 instructions where the signature, pubkey, and message data are all self-contained within the instruction's data field (offset struct entries with `sig_ix = 0xFFFF`, `pubkey_ix = 0xFFFF`, `msg_ix = 0xFFFF`). Cross-instruction data references are rejected.

For each accepted entry, the parser checks message equality against the expected handshake hash, then checks the signing pubkey against the verifier set. Duplicate pubkeys are deduplicated. The final unique authorized count is compared against threshold.

This mechanism relies on Solana's Ed25519 precompile (`Ed25519SigVerify111...`). The precompile verifies the cryptographic signature before the program sees the instruction data. The program does not perform Ed25519 verification itself.

---

## 4. Nullifier Replay Protection

Each withdrawal instruction passes a 32-byte `nullifier` value. The program derives a PDA:

```
seeds = [b"nullifier", intent.nullifier]
program_id = shielded_pool_anchor
```

This PDA is the `nullifier_marker` account passed to the instruction. The Anchor `init_if_needed` constraint creates this account on first use. The account stores a single `bool used`.

Before settlement, the program checks `!nullifier_marker.used`. After settlement, it sets `nullifier_marker.used = true`.

The nullifier PDA is deterministic: the same nullifier bytes always map to the same account address. Attempting a replay with the same nullifier will find the account already exists with `used = true` and fail with `NullifierAlreadyUsed`.

**What this protects:** prevents the same signed intent from being submitted more than once.

**Atomicity:** a failed withdrawal transaction — due to attestation failure, expiry, insufficient pool balance, fee too low, or any other rejection — does **not** consume the nullifier. Solana instruction atomicity rolls back all account mutations on failure, including the `NullifierMarker` account creation performed by `init_if_needed`. The same nullifier is safe to retry in a subsequent transaction after the error condition is corrected.

**What this does not protect:** if two different signed intents share the same nullifier bytes, they will race on submission. Only the first transaction to land successfully consumes the nullifier; the second must fail with `NullifierAlreadyUsed`. The on-chain program prevents double execution, but does not prevent the ambiguity itself. Verifiers must ensure nullifier uniqueness across the intents they sign — signing two conflicting intents with the same nullifier creates a race and leaves one intent permanently unexecutable, even though no double-spend can occur.

---

## 5. Binding Constraints (On-Chain Enforced)

These are verified by the Anchor `Accounts` struct constraints before the handler runs:

| Field | Enforcement |
|---|---|
| `intent.relayer` | Transaction must be signed by this pubkey (`Signer` constraint + `constraint = relayer.key() == intent.relayer`) |
| `intent.recipient` | The recipient account in the transaction must have exactly this address (`address = intent.recipient`) |
| `intent.nullifier` | PDA seeds include nullifier bytes — wrong account address means wrong PDA |
| `pool_state` | PDA verified by seeds `[b"pool_state"]` and bump |
| `config` | PDA verified by seeds `[b"verifier_config"]` and bump |
| `instructions_sysvar` | Must be the canonical `Instructions` sysvar address |

These bindings mean: the relayer cannot redirect funds to a different recipient, cannot use a different pool, and cannot substitute a different config. The on-chain program verifies these before any logic runs.

---

## 6. Field Semantics

### `chain_id`

Set once at `initializeConfig`. The program checks `intent.chain_id == config.chain_id` on every withdrawal. The purpose is to prevent intent replay across different deployments of the same program (e.g., different chain_id for mainnet vs devnet). There is no mechanism to update `chain_id` after initialization.

For this alpha, `chain_id = 1`.

### `policy_id`

A single byte included in both the intent hash and the handshake hash. The on-chain program does not check this value against any allowed set. The verifier is responsible for refusing to sign intents with disallowed policy_id values.

The field binds the verifier's signature to a specific policy context. What constitutes a valid policy_id is an off-chain protocol concern.

### `nonce`

A `u64` included in the intent hash. The on-chain program does not check nonce values against any sequence or uniqueness constraint beyond the nullifier. Two intents with different nullifiers but the same nonce are both valid on-chain.

The nonce is available to verifiers and off-chain systems for ordering and deduplication purposes.

### `audit_hash`

A 32-byte value included in both the intent hash and the handshake hash. The on-chain program stores and hashes this value but does not interpret it. It is a commitment to an off-chain audit record: the verifier binds their signature to an audit log entry.

There is no on-chain verification that the `audit_hash` corresponds to any valid record. The field is useful for off-chain indexers that want to correlate on-chain events with off-chain audit data.

### `commitment` and `merkle_root`

These fields are included in the intent hash and are signed by verifiers in the plain `withdraw` path. The on-chain program does not interpret them for that path — their semantic validity is the verifier committee's responsibility. The `withdraw_zk` instruction does verify a Groth16 circuit against `[root, nullifier_hash, tx_hash]`; `commitment` and `merkle_root` there are not separate instruction arguments.

---

## 7. Admin Authority

`config.admin_authority` is the public key of the wallet that called `initializeConfig`. This key has the following powers:

- Rotate the verifier set to any valid set (1–8 non-duplicate, non-zero pubkeys)
- Update the threshold (1 ≤ threshold ≤ verifier count)
- Pause or unpause the protocol
- Rotate `root_submitter_authority` to any non-default pubkey (`setRootSubmitterAuthority`)

`config.root_submitter_authority` is a separate key that controls the allowed-root registry:

- Add a Merkle root to `allowed_roots` (`addAllowedRoot`)
- Remove a Merkle root from `allowed_roots` (`removeAllowedRoot`)

At initialization (`initializeConfig`) and after migration from the previous layout, `root_submitter_authority` defaults to `admin_authority`. The admin can rotate `root_submitter_authority` to a dedicated hot key so that routine indexer operations do not require the admin key.

There is no mechanism to transfer `admin_authority` to another key. There is no time-lock or multi-sig on admin operations. A single admin key can rotate verifier settings, pause state, threshold, and `root_submitter_authority` in a single transaction. Because `admin_authority` can rotate `root_submitter_authority`, compromise of `admin_authority` can still regain control over allowed-root management even if day-to-day root submission uses a separate key.

**For this alpha, the admin is the single protocol operator.** This is appropriate for a private controlled deployment and is not a decentralized or multi-party setup.

---

## 8. Relayer Trust Assumptions

The relayer is the transaction fee payer and the entity that submits the withdrawal transaction. The relayer:

- Is named in the intent (`intent.relayer`)
- Must sign the transaction
- Receives `intent.fee` lamports on successful withdrawal
- Pays the rent for the `NullifierMarker` account (covered by `intent.fee`)

The relayer cannot:
- Modify the intent (the intent hash is signed by verifiers; tampering invalidates attestation)
- Redirect funds (recipient is bound by Accounts constraint)
- Choose which pool or config to use (PDAs are canonical)

The relayer can:
- Choose when to submit a signed intent (subject to expiry_slot)
- Refuse to submit an intent (denial of service against a specific withdrawal)
- Front-run other relayers for the same signed intent (first to submit consumes the nullifier)

---

## 9. On-Chain Events

The following events are emitted on successful operations:

| Event | Emitted when | Notes |
|---|---|---|
| `DepositReceived` | `deposit` instruction succeeds | Permissionless native SOL deposit. `amount > 0`. No denomination bucket check. No pause check. No note commitment. Public observability event — does not imply any privacy for the depositor. |
| `NoteDeposited` | `deposit_note` instruction succeeds | ZK note deposit scaffold. Commitment, denomination, leaf_index, depositor, slot. Emitted with full plaintext fields. **Does not provide depositor privacy at the transaction layer.** The depositor public key is visible in the transaction regardless of the event. Used by the local indexer pipeline and the live indexer path. |
| `WithdrawExecuted` | `withdraw` instruction succeeds | `amount` is the **gross** intent amount (pre-fee). Net recipient transfer = `amount - fee`. |
| `NullifierConsumed` | `withdraw` or `withdraw_zk` instruction succeeds | Emitted before `WithdrawExecuted` / `ZkWithdrawExecuted` in the same transaction. |
| `ZkWithdrawExecuted` | `withdraw_zk` instruction succeeds | `nullifier_hash`, `recipient`, `relayer`, `denomination`, `fee`, `circuit_version`, `slot`. In the default build, `tx_hash` is computed on-chain and verified by the real Groth16 verifier — `recipient`, `relayer`, `denomination`, `fee`, `chain_id`, `expiry_slot`, and `circuit_version` are cryptographically bound. In mock-verifier mode (`--features mock-verifier`), a local-test-only fixture check is used instead. |
| `VerifierConfigUpdated` | `update_verifier_config` succeeds | Emitted on every config update, including pause/unpause changes. |
| `ProtocolPaused` | Config update sets `paused = true` | Emitted in addition to `VerifierConfigUpdated`. |
| `ProtocolUnpaused` | Config update sets `paused = false` while previously paused | Emitted in addition to `VerifierConfigUpdated`. |

Event field names use camelCase when decoded by Anchor's TypeScript SDK (e.g., `intentHash`, `signerCount`, `verifierCount`). The Rust struct uses snake_case (`intent_hash`, `signer_count`, `verifier_count`).

### Indexer and event data availability

The `NoteDeposited` event provides the commitment and leaf_index needed for the off-chain Merkle tree indexer to maintain the local tree state and generate Merkle proofs for provers. Indexer data availability and correctness are important for UX and proof preparation: a prover cannot generate a valid withdrawal proof without a correct Merkle path from the indexer.

However, **the indexer does not grant withdrawal authority.** Withdrawal authorization still requires a threshold of configured Ed25519 verifier signatures over the handshake hash (see §2–§3). An indexer that returns a correct Merkle path does not allow a withdrawal to succeed unless the verifier committee also signs the intent. A compromised or incorrect indexer can cause withdrawal failures (by providing wrong paths) but cannot authorize unauthorized withdrawals.

The `withdraw_zk` instruction runs a real on-chain Groth16 proof verifier (`WITHDRAW_SOL_V1`). The public inputs `[root, nullifier_hash, tx_hash]` are verified against the binary-embedded VK via `alt_bn128_versioned_pairing`. The plain `withdraw` instruction does not run a ZK verifier — `commitment` and `merkle_root` in that path are signed by the Ed25519 verifier committee but not checked against any circuit. See §2 for that trust model.

---

## 10. Upgrade Authority

The upgrade authority keypair (`<UPGRADE_AUTHORITY_KEYPAIR>`,
pubkey `GdiRFMEZs9Tpt3sbTEgg5o1x1aPVC4fy236S64mNrpax`) controls the BPF
Upgradeable Loader for this program. It is a separate role from `admin_authority`
and has a larger blast radius.

**What upgrade authority controls:**

- Deploying a replacement program binary to the same program ID
- Any binary deployed takes effect immediately with no on-chain delay

**How it differs from `admin_authority`:**

`admin_authority` (§7) controls on-chain config: it can rotate verifiers, update
thresholds, and pause the protocol — all via the existing program's instruction
handlers. A malicious holder of the admin key is constrained by the program's
existing logic.

The upgrade authority operates at a different level. A malicious upgrade can:

- Remove the attestation check — making the verifier committee irrelevant
- Remove the pause check — making admin authority irrelevant
- Remove nullifier replay protection
- Add arbitrary new instructions, including a direct pool drain
- Silently weaken any other on-chain control

In short: upgrade authority compromise can render all other protocol guarantees
meaningless without touching the existing admin or verifier keys.

**Current model:**

- Single keypair, no timelock, no multisig, no on-chain governance
- Transfer is possible only via `solana program set-upgrade-authority` (external
  Solana CLI, not a script in this repository)
- The program can be frozen permanently using `--final`, which eliminates upgrade
  authority as an attack surface but also prevents any future patches

**Operator practice:**

- Store the `<UPGRADE_AUTHORITY_KEYPAIR>` separately from routine operational keys. Admin, relayer, and verifier keys need to be accessible for routine operations; the upgrade authority should not be in the routine operational set.
- Prefer offline or hardware-protected storage for the upgrade authority when the protocol is not being actively upgraded.
- Record the upgrade authority public key in the release snapshot for every deployment.
- After any binary upgrade, verify the deployed binary hash against the locally built artifact (see Detection below) before resuming operations.

**Compromise response:** See `docs/INCIDENT_RESPONSE.md` IR-4.

**Detection:** Verify the deployed binary against the release snapshot. Use prefix comparison
because the on-chain ProgramData account may include zero-padded extension bytes beyond the
local `.so` after `solana program extend`:

```bash
solana program dump E593efjkVU3Z6pJQtSLf7jECFeGBVy2UQZwET4nqLhyq downloaded.so \
  --url https://api.devnet.solana.com
LOCAL_SIZE=$(wc -c < target/deploy/shielded_pool_anchor.so)
cmp -n "$LOCAL_SIZE" downloaded.so target/deploy/shielded_pool_anchor.so && echo "PREFIX_MATCH=YES"
head -c "$LOCAL_SIZE" downloaded.so > downloaded.trimmed.so
sha256sum downloaded.trimmed.so target/deploy/shielded_pool_anchor.so
rm -f downloaded.so downloaded.trimmed.so
# PREFIX_MATCH=YES must appear; both sha256sum lines must match.
# Current devnet trimmed hash: 45411a75943950a1450f67a120f680972d0a100a3c9937677003ffb7c1671591
# Update this comment after each deployment.
```

**Staged hardening options (not currently implemented):**

These options exist for deployments that require stronger upgrade-authority guarantees.
None are implemented in this alpha. They are listed in increasing order of protection.

| Stage | Description | Status |
|---|---|---|
| **0 (current)** | Single-key upgrade authority, offline storage, operational key separation from admin key; documented manual verification and incident response procedures | Implemented |
| **1** | Automated on-chain authority verification before every deployment (`deploy_devnet.sh` pre-flight); live check in `devnet_doctor.ts` that fails on unexpected authority | Implemented (`deploy_devnet.sh` check 7, `devnet_doctor.ts` parsed check) |
| **2** | Transfer upgrade authority to a multisig (e.g., Squads v4 on Solana); requires M-of-N key holders to co-sign any upgrade transaction; eliminates single-key upgrade compromise | Not implemented |
| **3** | Add a timelock to the upgrade path — any upgrade proposal must be queued and must wait a configurable delay period before taking effect; gives the ecosystem time to detect and respond | Not implemented |
| **4** | Permanently freeze the binary (`solana program set-upgrade-authority --final`); eliminates upgrade authority as an attack surface entirely; **irreversible** — no further patches possible | Not implemented |

For the current private devnet alpha, Stages 0 and 1 are appropriate. Stage 2 requires
external multisig tooling. Stage 3 requires governance infrastructure. Stage 4 is
appropriate only once the protocol is considered stable and no future patches are expected.

### Mock-verifier deployment guard

`scripts/run_all_tests.sh` builds the program with `--features mock-verifier` for local
integration test coverage of the `withdraw_zk` path. A binary built with this flag
replaces Groth16 proof verification with a deterministic local-test-only fixture check.
The fixture check is not cryptographically secure — anyone who can construct a valid
fixture for any recipient can drain the pool without a real ZK proof.

`scripts/deploy_devnet.sh` always removes any stale `target/deploy/shielded_pool_anchor.so`
and rebuilds from source without feature flags before deploying. After the rebuild it runs
`scripts/ops/check_deploy_artifact_not_mock.sh`, which scans the binary for two sentinel
strings that are present only in mock-verifier builds:

- `"MOCK VERIFIER ENABLED"` — `withdraw_zk` mock-verifier `msg!` log line
- `"Groth16 proof check skipped"` — same `msg!` string

If either sentinel is found the deploy is refused with an explicit error. This guard
reduces the risk of accidental mock-verifier deployment; it is not a substitute for
release artifact signing, audited build tooling, or multisig upgrade governance.

For the real-verifier CU benchmark, see
[`docs/ZK_REAL_PROOF_CU_BENCHMARK.md`](ZK_REAL_PROOF_CU_BENCHMARK.md).

---

## 11. What Is Not Enforced On-Chain

For clarity, the following are **not** on-chain guarantees:

- That pool lamports reflect only protocolized deposits (anyone can still raw-transfer SOL to the pool PDA, bypassing `total_deposits` accounting and the `DepositReceived` event)
- That the `merkle_root` corresponds to any valid Merkle tree (the root registry enforces allowlist membership, not tree validity)
- That the `commitment` was derived from any specific circuit
- That `policy_id` is within any valid range
- That `nonce` is unique or sequential
- That `audit_hash` corresponds to a real audit record
- That the verifier committee has not colluded
- That the admin has not rotated verifiers to compromised keys

---

## 12. Current Non-Goals of the Alpha

These properties are explicitly not provided:

- **Production privacy.** The `withdraw_zk` path verifies a real Groth16 proof, but this is not production privacy. The plain `withdraw` path has plaintext parameters. Real privacy depends on anonymity set size, denomination discipline, relayer behavior, and operational setup.
- **Trustless operation.** The protocol requires trust in the verifier committee (currently a single operator).
- **Decentralized governance.** Admin operations are controlled by a single key with no time-lock or governance process.
- **SPL token support.** Native SOL only.
- **Cross-chain settlement.** The `chain_id` field is a binding constraint, not a bridge mechanism.
- **Formal security proofs.** The protocol has not been formally verified or audited.
