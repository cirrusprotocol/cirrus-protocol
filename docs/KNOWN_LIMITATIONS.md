# Known Limitations

> This document lists known limitations and design gaps of the current alpha implementation.

---

## Protocol Limitations

### Local-only `mock-verifier` mode

The `withdraw_zk` instruction can be compiled with a `mock-verifier` feature flag
(`--features mock-verifier`) for local integration tests. In that mode, real Groth16 proof
verification is replaced by a deterministic local-test-only fixture check (see below). A
binary built with `--features mock-verifier` is not production-safe: anyone who can
construct a valid fixture for any recipient can drain the pool without a real ZK proof.

The default build (without `--features mock-verifier`) runs real Groth16 proof verification
for `withdraw_zk`. A binary built with `--features mock-verifier` is for local integration
tests only and must never be deployed.

`scripts/run_all_tests.sh` builds with `--features mock-verifier` for local test coverage.
That binary must never be deployed to devnet or mainnet. Do not manually deploy
`target/deploy/shielded_pool_anchor.so` after running `run_all_tests.sh`.

**Deployment guard:** `scripts/deploy_devnet.sh` always removes any stale artifact and
rebuilds from source without feature flags before deploying. After the rebuild it runs
`scripts/ops/check_deploy_artifact_not_mock.sh`, which scans the binary for sentinel
strings that are present only in mock-verifier builds and refuses to proceed if any are
found. This guard reduces the risk of accidental mock-verifier deployment; it is not a
substitute for release artifact signing or independent review.

Before any manual deploy outside the deploy script, run:

```bash
anchor build                  # no --features flag
bash scripts/ops/check_deploy_artifact_not_mock.sh target/deploy/shielded_pool_anchor.so
```

**Local-test-only proof fixture:** in mock-verifier mode, `withdraw_zk` validates a
deterministic fixture format that encodes the expected public inputs and account pubkeys
into `proof_a`, `proof_b`, and `proof_c`. The fixture binds `root`, `nullifier_hash`,
`tx_hash`, `program_id`, pool state PDA, config PDA, `recipient`, and `relayer`.
Submitting the wrong values for any of these returns `InvalidProof` in integration tests.
This is a byte-level test harness convention, not cryptographic proof security. In mock
verifier mode the following are NOT enforced at a cryptographic level and are deferred to
real Groth16 integration:

- Real Groth16 pairing verification (the fixture check is not a cryptographic proof)
- `chain_id` proof binding (wrong `chain_id` changes the fixture's `tx_hash`, but this
  is still only a byte comparison, not a cryptographic security property)
- Recipient and relayer cryptographic binding (the fixture check is bypassable by
  constructing the correct fixture bytes for any target accounts)

See [`ZK_REAL_PROOF_CU_BENCHMARK.md`](ZK_REAL_PROOF_CU_BENCHMARK.md) for the real-verifier
CU benchmark and test coverage details.

### No admin authority transfer

`config.admin_authority` is set permanently at `initializeConfig` and cannot be transferred to another key. There is no `transfer_admin` instruction.

**Impact:** If the admin keypair is lost, no one can rotate verifiers, change the threshold, or unpause the protocol. The protocol becomes permanently frozen. The only recovery would be a program upgrade (which requires the upgrade authority keypair to also be available), and even then it would require a custom migration instruction.

**Acceptable for alpha?** Yes, in a single-operator devnet alpha where the operator controls all keys. Not acceptable in any multi-party or production setting.

### No chain_id update

`config.chain_id` is set at `initializeConfig` and cannot be modified. There is no instruction to update it.

**Impact:** If the alpha is initialized with `chain_id = 1` and the protocol later needs to use a different value, the config PDA must be destroyed and re-created (which is not currently possible without a program upgrade or a new deployment). All intent builders must use `chain_id = 1` for the lifetime of the config.

### No emergency drain or recovery instruction

There is no instruction for the admin to drain the pool, close accounts, or recover deposited SOL in an emergency.

**Impact:** SOL deposited into the pool PDA can only exit via authorized withdrawal. If the verifier key is lost and the admin key is also lost, the SOL is inaccessible without a program upgrade.

### Raw lamport transfers bypass deposit accounting

The `deposit` instruction is the protocolized way to fund the pool. It updates `pool_state.total_deposits` and emits a `DepositReceived` event. However, anyone can still send SOL to the pool PDA via a raw `SystemProgram.transfer` at the Solana account level. Raw transfers:

- Add lamports to the pool PDA and make them available for withdrawals.
- Do NOT update `pool_state.total_deposits`.
- Do NOT emit `DepositReceived`.

This is not a security issue — SOL in the pool can only exit via authorized withdrawal regardless of how it arrived. It is an accounting gap: `total_deposits` reflects only protocolized deposits, not total historical inflows.

### No SPL token support

Only native SOL is supported. All amounts are in lamports.

---

## Trust Model Limitations

### Single-operator assumption

The verifier committee currently consists of keys controlled by a single operator. There is no cryptographic or on-chain mechanism that enforces separation of the signing key from the admin key. A single party with access to both keys can authorize arbitrary withdrawals to arbitrary recipients.

This is an intentional design choice for a single-operator devnet alpha, not an oversight.

**Threshold does not imply multi-party security when keys are co-located.** Even a 2-of-3 or 3-of-5 configuration provides no stronger protection than 1-of-1 if the same operator holds all signing keys. An operator with all n keys can produce any threshold-many signatures themselves. Threshold security is meaningful only when keys are held by genuinely independent parties — where no one party can produce threshold-many signatures on their own. The on-chain program has no mechanism to verify or enforce key holder independence; this is an operational responsibility.

### Off-chain policy enforcement

`policy_id`, `nonce`, `audit_hash`, and `commitment` are included in the canonical hash but are not validated on-chain. The on-chain program verifies only that a threshold of authorized keys signed a hash that includes these fields. Whether the field values are semantically valid is entirely an off-chain responsibility.

`merkle_root` is also included in the canonical hash and is additionally subject to the opt-in root registry described below. When the registry is empty (default), `merkle_root` is verifier-attested only. When populated, the on-chain program enforces that `intent.merkle_root` is present in `config.allowed_roots`.

A verifier that signs intents without checking these fields provides no meaningful policy enforcement.

### Merkle root registry is opt-in for plain withdraw; empty registry means any root is accepted there

Scope: this section describes the plain non-ZK `withdraw` path, where `merkle_root` is part of a verifier-attested intent. It does not describe `withdraw_zk`. The `withdraw_zk` path is fail-closed: an empty `allowed_roots` aborts with `NoAllowedRootsConfigured`, and an unlisted root aborts with `UnknownMerkleRoot`.

`VerifierConfig.allowed_roots` is a list of approved Merkle roots managed by `root_submitter_authority`. The `addAllowedRoot` and `removeAllowedRoot` instructions require the signer to be `root_submitter_authority`. The admin can rotate `root_submitter_authority` via `setRootSubmitterAuthority`; it defaults to `admin_authority` at initialization and after migration.

**When empty (default):** the on-chain program does not enforce `intent.merkle_root`. Any root value in a verifier-attested intent will be accepted. This preserves backwards compatibility and is the default alpha deployment mode.

**When non-empty:** the on-chain program requires `intent.merkle_root` to be present in `config.allowed_roots`. Intents with unlisted roots are rejected with `UnknownMerkleRoot`.

This is not a Merkle tree membership proof or deposit commitment check. It is a simple allowlist. The correctness of the tree structure and the relationship between roots and deposits remains an off-chain verifier responsibility.

### `attester_pubkey` is stored metadata, not enforced

`VerifierConfig.attester_pubkey` is written at `initializeConfig` and persisted in the config PDA, but it is not read during withdraw verification. Verifier authorization is enforced exclusively by threshold signature checking over `config.verifier_pubkeys`.

`attester_pubkey` should be treated as a reserved label field in the current alpha. It is not updated by `updateVerifierConfig`, so it becomes stale after the first verifier rotation. There is no on-chain validation that the stored key is non-zero or present in `verifier_pubkeys`.

Changing this so that the designated attester must always be one of the signing verifiers would be a protocol design change, not a bug fix.

### No formal verification or audit

This codebase has not been formally verified or independently audited. The attestation parser (`attestation.rs`) implements custom Ed25519 instruction introspection that has been reviewed internally and covered by integration tests, but has not been audited by an external security firm.

---

## Operational Limitations

### Root lifecycle is manual

`allowed_roots` holds at most `MAX_ROOTS` entries (currently 10). There is no automatic root eviction, TTL, or rotation policy. The operator is responsible for removing stale roots before the list fills. When the list is full, `addAllowedRoot` calls will fail on-chain with a capacity error.

Monitor root capacity before root submission and before live withdrawal testing using `scripts/ops/analyze_allowed_roots_hygiene.ts`. Remove roots that are no longer needed by active tests via `removeAllowedRoot` signed by the root-submitter authority. Use `scripts/ops/remove_allowed_root_devnet.ts` for a guarded removal flow (dry-run to preview, `--yes` to send). Do not remove a root if a pending withdrawal test still expects it.

See `docs/DEVNET_ALPHA_RUNBOOK.md` §2.8 for the root lifecycle decision procedure.

### Verifier rotation with ephemeral keys

The legacy operator admin flow's `--rotate` command generates ephemeral keypairs (`Keypair.generate()`) in memory and rotates the config to those keys. When the script exits, the keys no longer exist. The protocol is left with a verifier set that cannot produce attestations.

This command is suitable only for demos that immediately follow with a second rotation to a known persistent key. It must not be used to establish a real verifier set.

### `--test-withdraw` silent restore failure

The legacy operator admin flow's `--test-withdraw` command temporarily rotates the verifier config to an ephemeral test key, performs a withdrawal, and then attempts to restore the original config. The restore step may fail silently (the catch block logs a message and continues). If restore fails, the config is left pointing at an ephemeral key.

There is no automatic detection of this condition. An operator must re-read the config (the legacy admin flow's `--print`) after `--test-withdraw` to verify the config was restored.

### Test suites require separate validators

The validator-backed integration suites (`withdraw.ts`, `admin_hardening.ts`,
`attestation_threshold.ts`, `migration.ts`, `deposit.ts`, `init_note_tree.ts`,
`deposit_note.ts`, `withdraw_zk.ts`) share the same config PDA
(`seeds = [b"verifier_config"]`). Each suite initializes it with different parameters.
They cannot run against the same ledger.

Running `anchor test` executes only `withdraw.ts`. Use `bash scripts/run_all_tests.sh`
or `anchor run test_all` to run all validator-backed suites in isolated validator
sessions.

### Devnet airdrop rate limiting

The demo and admin scripts request airdrops via `requestAirdrop`. Devnet rate-limits these requests. Scripts will fail with a clear error message if rate-limited. Use `--use-payer-as-relayer` and manual pool funding (`solana transfer`) to avoid this dependency.

### Expiry slot sensitivity on devnet

The intent expiry slot is computed as `current_slot + expiryOffset` (default 200 slots ≈ 80 seconds at 0.4s/slot). Devnet slot times are not guaranteed. During congestion, transactions may land after the expiry slot. Operators should use `--expiry-offset 500` or higher on devnet.

### No concurrent multi-relayer support

There is no mechanism to prevent two relayers from attempting to submit the same signed intent simultaneously. The first submission consumes the nullifier. The second fails with `NullifierAlreadyUsed`. For a single-operator alpha this is not an issue, but it matters if multiple relayers are operating independently.

### WebSocket/live subscription indexer is not implemented

The current indexer/operator flow is snapshot- and RPC-fetch based. It does not maintain a live WebSocket subscription, does not continuously follow new `NoteDeposited` events, and does not automatically reconcile forks or reconnect after subscription failures.

Operators must explicitly fetch or rebuild snapshots before witness/proof generation and should verify snapshot provenance before relying on a root for `withdraw_zk` testing.

This is acceptable for controlled devnet-alpha testing, but it is not a production monitoring/indexing setup.

### No automated monitoring or alerting

Devnet-alpha does not run an automated monitor for verifier config health, allowed-roots capacity, root freshness, pool balance, nullifier state, or proof/send readiness.

Before test sessions, operators should manually run the relevant read-only diagnostics and verifiers, such as:

- `scripts/ops/analyze_allowed_roots_hygiene.ts`
- `scripts/ops/analyze_snapshot_hygiene.ts`
- `scripts/ops/verify_withdraw_zk_send_devnet.ts` after live sends
- `scripts/ops/inspect_allowed_roots_devnet.ts` when root state needs inspection

A clean diagnostic output is not a privacy guarantee, production approval, or audit result. These tools are operator guardrails for controlled devnet-alpha testing.

### ZK artifact provenance is not public-release complete

Devnet-alpha proving artifacts are handled as local/external artifacts. Public-release
readiness requires pinned toolchain versions, reproducible generation instructions,
trusted setup/proving key provenance, and checksums for distributed artifacts. The current
setup uses a single local Phase 2 contribution; no multi-party ceremony has been conducted.

See `docs/ZK_ARTIFACTS.md` for the current artifact manifest and known gaps.

---

## Devnet-Specific Constraints

These limitations apply specifically to the current devnet alpha and may not apply to a future mainnet deployment:

- SOL amounts are devnet SOL with no real value.
- Airdrop availability depends on Solana devnet health.
- The program upgrade authority is the operator wallet — any keypair holder can upgrade (and break) the program. It has no time-lock or multi-sig protection. See `docs/INCIDENT_RESPONSE.md` IR-4 for the compromise procedure and blast-radius analysis.
- Program state will be lost if the devnet ledger resets (which Solana devnet does periodically).
- No monitoring or alerting infrastructure exists. Incident response procedures are documented in `docs/INCIDENT_RESPONSE.md` but require manual operator action.

### npm dependency vulnerabilities

`npm audit` reports 7 vulnerabilities (1 low, 3 moderate, 3 high). All are in `mocha` and its transitive deps (`diff`, `js-yaml`, `minimatch`, `nanoid`, `serialize-javascript`, `uuid`). None affect the on-chain program binary.

| Package                | Severity | Issue                                                                       |
| ---------------------- | -------- | --------------------------------------------------------------------------- |
| `diff`                 | Low      | DoS in parsePatch/applyPatch — used only for mocha test output diff display |
| `js-yaml`              | Moderate | Prototype pollution in merge — used by mocha internals                      |
| `minimatch`            | High     | ReDoS via repeated wildcards — used by mocha for test file glob matching    |
| `nanoid`               | Moderate | Predictable output for non-integer inputs — used by mocha internals         |
| `serialize-javascript` | High     | RCE via RegExp.flags, DoS, XSS — used by mocha for serialization            |
| `uuid`                 | Moderate | Buffer bounds check missing in v3/v5/v6 — transitive dev dep                |
| `mocha`                | High     | Aggregated from the above direct deps                                       |

**Impact:** None on the deployed program. No npm package runs inside the validator or BPF bytecode. The test runner is only invoked locally during development and CI.

**Acceptable for alpha?** Yes, for a private dev environment. Not acceptable if the test toolchain is used in a shared CI environment with access to sensitive credentials (e.g., mainnet keypairs).
