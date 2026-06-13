# Cirrus Protocol — Shielded Pool Anchor (devnet alpha)

> **Status:** Cirrus Protocol devnet alpha — an unaudited research prototype on Solana devnet. Single-operator deployment. Do not use with real funds. No privacy guarantee.
>
> The real `WITHDRAW_SOL_V1` Groth16 verifier path is wired and tested locally with LiteSVM,
> and one withdrawal has been completed end-to-end on devnet. This is not production privacy.
> Real privacy also depends on anonymity set size, denomination discipline, relayer behavior,
> secret handling, and operational setup.

Cirrus Protocol's **Shielded Pool Anchor** is a Solana/Anchor prototype for fixed-denomination SOL withdrawal experiments — a private-settlement prototype, not a privacy product. Withdrawals are mediated by relayers and authorized by either a configurable committee of Ed25519 signing keys (`withdraw`) or a Groth16 ZK proof (`withdraw_zk`). The on-chain program enforces relayer and recipient binding, nullifier replay protection, and chain-id isolation.

---

## Cirrus Protocol devnet alpha

In plain language: this is a Solana **devnet** alpha for a zero-knowledge withdrawal /
private-settlement prototype. Testers deposit a fixed denomination into a shared pool and
later withdraw it, with the `withdraw_zk` path gated by a real Groth16 proof of note
ownership and Merkle membership. It runs only on devnet, with test SOL, under a single
operator. It is **not** a mixer and makes **no privacy guarantee** — see
[What is not claimed](#what-is-not-claimed).

- **Shared Cirrus devnet alpha pool.** Testers are guided toward one shared pool — a single
  program deployment, pool, note tree, and root allowlist with one recommended bucket
  (1 SOL) — instead of each spinning up isolated local pools. Sharing one pool builds a
  larger common test set. The shared profile ships only public devnet addresses; it holds
  no keys and no secrets.
- **Guided CLI path.** `devnet-alpha run` (from the `@cirrusprotocol/devnet-alpha` package
  scaffold) is the guided entrypoint. It is a command **planner**, not a live runner: it
  produces the ordered, copy-pasteable commands for the simulate-only flow.
- **Source checkout required for now.** The package is an unpublished scaffold. `run`
  forwards planner arguments to the in-repo planner (`scripts/ops/devnet_alpha_plan.ts`) and
  needs a checkout of this repository; standalone (no-checkout) operation is not supported yet.
- **Simulate-first.** The default target is simulation (`--simulate`): a read-only preflight
  that broadcasts nothing and consumes no nullifier. A live send is a separate, explicit
  operator step.
- **Operator-managed root submission.** Adding a Merkle root to the on-chain allowlist is an
  operator action. The guided planner and the `run` wrapper never submit roots.

### What works today

- **Note secret generator** — `scripts/ops/generate_note_secret.ts` produces a fresh note
  secret + commitment outside the repo; the secret is never printed.
- **ZK artifact verifier** — checks local `.zkey`/`.wasm` against the artifact manifest before
  they are used.
- **Guided devnet alpha planner** — `scripts/ops/devnet_alpha_plan.ts`, the simulate-first
  command planner.
- **npm package scaffold** — `@cirrusprotocol/devnet-alpha` (`private`, unpublished) exposing
  the `run` and `plan` commands and the shared-pool profile.
- **Packed-package smoke** — a test packs the package via `npm pack` and runs the CLI from the
  packed artifact, asserting the tarball ships only `package.json`, `README.md`, and the built CLI.
- **`devnet-alpha run` → planner** — from a checkout, `run` forwards arguments to the in-repo
  planner and refuses any live-action argument before doing so.
- **One live devnet withdrawal (N=1)** — a fresh note was deposited, proved with a real Groth16
  proof, and spent on-chain; the nullifier PDA was created and balances settled (see
  [`docs/status/devnet/2026-06-08-withdraw-zk-live-send-smoke.md`](docs/status/devnet/2026-06-08-withdraw-zk-live-send-smoke.md)).
- **Repeat run (N=2) reached the simulate stage** — a second withdrawal was exercised through
  the simulate-first preflight; a live re-send remains an explicit operator step.

### What is not claimed

- **No audit.** This codebase has not been independently audited.
- **No mainnet.** Devnet only; do not use real funds. Devnet resets periodically and destroys
  all on-chain state.
- **No production readiness.** It is a research prototype.
- **No privacy guarantee.** Recipient, relayer, amount, and fee are plaintext on-chain for both
  withdrawal paths. Do not read "anonymous" or "private" as a guarantee here.
- **Not Tornado-level privacy.** The shared pool is Tornado-like in shape only; it does not
  provide a comparable anonymity set or guarantees.
- **No automatic root submission.** Root submission stays operator-managed.
- **No artifact auto-download.** `.wasm`/`.zkey` proving artifacts are not committed and are not
  fetched for you; obtain them per [`docs/ZK_ARTIFACTS.md`](docs/ZK_ARTIFACTS.md).
- **npm package not published.** `@cirrusprotocol/devnet-alpha` is `private` and unpublished.

### Quickstart (guided devnet alpha)

```bash
# 1. Clone and install
git clone <repo_url> shielded_pool_anchor
cd shielded_pool_anchor
npm install

# 2. Run the local test suite (no devnet, no validator)
npm run test:zk-indexer

# 3. Build the guided CLI scaffold (not published to npm)
npm --prefix packages/devnet-alpha run build

# 4. See the guided entrypoint and the shared-pool profile
node packages/devnet-alpha/dist/cli.js run --help

# 5. From this checkout, `run` forwards planner args to the in-repo planner
node packages/devnet-alpha/dist/cli.js run --dry-run
#    (equivalently, invoke the planner directly)
npx ts-node --project tsconfig.json scripts/ops/devnet_alpha_plan.ts --dry-run
```

New tester? Start with [`docs/TESTER_ONBOARDING.md`](docs/TESTER_ONBOARDING.md), then
[`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md).

---

## What it does

- **Intent-based withdrawals.** A withdrawal intent specifies recipient, amount, relayer, fee, expiry, and a nullifier. The relayer submits the transaction; the on-chain program enforces all account bindings.
- **Threshold attestation.** Configurable k-of-n Ed25519 signature verification using Solana's instruction introspection (`Ed25519SigVerify` precompile). "Attestation" here means Ed25519 threshold signature verification — not ZK proof attestation.
- **Replay protection.** Each withdrawal consumes a nullifier via a PDA-seeded `NullifierMarker`. A nullifier can only be used once.
- **Admin controls.** Verifier set rotation, threshold updates, and pause/unpause — all gated by `admin_authority`. Only the initializing admin can modify config.
- **Canonical hashing.** Intent hash (Keccak256, 248-byte preimage) and handshake hash (Keccak256, 196-byte preimage) with versioned domain tags, verified by cross-language parity tests.
- **ZK withdrawal (`withdraw_zk`).** Fixed-denomination withdrawals verified on-chain with real Groth16/BN254. The `tx_hash` public input binds recipient, relayer, pool and config PDAs, denomination, fee, `chain_id`, expiry slot, and circuit version. The verifier checks `[root, nullifier_hash, tx_hash]` via `alt_bn128_versioned_pairing`. LiteSVM integration tests run the real proof path and confirm tampered proof rejection.
- **On-chain events.** `WithdrawExecuted`, `ZkWithdrawExecuted`, `VerifierConfigUpdated`, `ProtocolPaused`, `ProtocolUnpaused`, `NullifierConsumed` — structured for indexing and observability.

## What is not promised

- **Not production privacy.** The `withdraw_zk` ZK path proves membership and binds withdrawal parameters, but real privacy depends on anonymity set size, denomination discipline, relayer behavior, secret handling, and operational setup. The plain `withdraw` path does not use ZK — recipient, amount, relayer, and fee are plaintext.
- **Not audited.** This codebase has not been independently audited.
- **Not mainnet ready.** Unaudited, single-operator, devnet-alpha only. Do not use with real funds.
- **Not trustless.** The verifier committee is a single operator. A threshold of verifier keys can drain the pool.
- **No SPL token support.** Native SOL only.
- **No frontend.**
- **No cross-chain bridge.** The `chain_id` field prevents replay across deployments, not a cross-chain mechanism.

---

## Trust model

The current deployment is **single-operator**:

- The verifier committee consists of keys controlled by a single party. A threshold of those keys can authorize any withdrawal.
- `admin_authority` is set permanently at initialization — there is no transfer mechanism. If the admin keypair is lost, the protocol cannot be administratively modified.
- The **upgrade authority** (`GdiRFMEZs9Tpt3sbTEgg5o1x1aPVC4fy236S64mNrpax`) controls the program binary and is a separate key from `admin_authority`. A holder of this key can deploy a replacement binary that bypasses all verifier, admin, and pause controls. This is a higher blast radius than admin key compromise. See `docs/INCIDENT_RESPONSE.md` IR-4 for the compromise response procedure.
- There is no time-lock, multi-sig, or governance process on admin or upgrade authority operations.

This is appropriate for a private controlled alpha. It is explicitly not a multi-party or decentralized deployment.

---

## Documentation

| Document                                                                               | Purpose                                                                                          |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [`docs/ZK_REAL_PROOF_CU_BENCHMARK.md`](docs/ZK_REAL_PROOF_CU_BENCHMARK.md)             | LiteSVM real Groth16 proof CU benchmark: measured CU, recommended devnet-alpha compute limit     |
| [`docs/SECURITY_MODEL.md`](docs/SECURITY_MODEL.md)                                     | What the on-chain program enforces vs. what it delegates off-chain                               |
| [`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md)                               | Design gaps, trust model limitations, operational constraints                                    |
| [`docs/DEVNET_ALPHA_RUNBOOK.md`](docs/DEVNET_ALPHA_RUNBOOK.md)                         | Operator procedures: deploy, initialize, smoke test, rotation, recovery                          |
| [`docs/DEVNET_UPGRADE_RUNBOOK.md`](docs/DEVNET_UPGRADE_RUNBOOK.md)                     | One-time upgrade procedure: binary upgrade + PDA migration from legacy to current account layout |
| [`docs/INCIDENT_RESPONSE.md`](docs/INCIDENT_RESPONSE.md)                               | Incident response: compromised admin key, broken verifier quorum, stuck EQE                      |
| [`docs/TESTER_ONBOARDING.md`](docs/TESTER_ONBOARDING.md)                               | Start here for alpha testers — what this protocol is and isn't, setup, known limitations         |
| [`docs/DEVNET_ALPHA_TESTER_QUICKSTART.md`](docs/DEVNET_ALPHA_TESTER_QUICKSTART.md)     | Command-first tester quickstart: status, deposit, root readiness, withdraw simulate              |
| [`docs/RECOVERY_PROCEDURES.md`](docs/RECOVERY_PROCEDURES.md)                           | Concrete recovery steps for known failure scenarios                                              |
| [`docs/FREEZE_MATRIX.md`](docs/FREEZE_MATRIX.md)                                       | Which files are frozen, which require migration, which may evolve                                |
| [`docs/releases/RELEASE_SNAPSHOT_v1_6_3.md`](docs/releases/RELEASE_SNAPSHOT_v1_6_3.md) | Known-good deploy record: program ID, slot, upgrade authority, trimmed SHA-256                   |
| [`docs/status/devnet/2026-06-08-withdraw-zk-real-proof-smoke.md`](docs/status/devnet/2026-06-08-withdraw-zk-real-proof-smoke.md) | Devnet real-proof `withdraw_zk` simulation record: proof path, parameters, result |
| [`docs/status/devnet/2026-06-08-withdraw-zk-live-send-smoke.md`](docs/status/devnet/2026-06-08-withdraw-zk-live-send-smoke.md) | First devnet live `withdraw_zk --send`: fresh note deposited, proved, spent on-chain; nullifier PDA created, balances settled |
| [`docs/status/devnet/2026-06-09-withdraw-zk-post-send-verifier.md`](docs/status/devnet/2026-06-09-withdraw-zk-post-send-verifier.md) | Read-only post-send verifier: signature status, nullifier PDA derivation, account owner/length, balances; 35 tests, 1119 total passing |
| [`docs/status/devnet/2026-06-09-snapshot-hygiene-report.md`](docs/status/devnet/2026-06-09-snapshot-hygiene-report.md) | Read-only local snapshot hygiene report: leaf count, latest selected leaf, denomination bucket population; no RPC/secrets/proofs; 46 focused tests, 1183 total passing |
| [`docs/status/`](docs/status/)                                                          | Historical planning/status notes, including Phase 4 Groth16 integration history.                |

---

## Repository structure

```
programs/shielded_pool_anchor/src/
  instructions/
    initialize_pool.rs          Pool state PDA initialization
    initialize_config.rs        Verifier config PDA initialization (signer becomes admin_authority)
    update_verifier_config.rs   Admin: verifier rotation, threshold, pause/unpause
    withdraw.rs                 Intent-based withdrawal handler
    attestation.rs              Ed25519 threshold attestation parser — HARD FREEZE
  state.rs                      Account structs, events, constants
  errors.rs                     Deterministic error codes — HARD FREEZE (codes are stable identifiers)
  lib.rs                        Instruction dispatch

crates/shielded-pool-interface/
  src/instruction.rs            Canonical hash preimage layout — HARD FREEZE
                                Keccak256 over 248-byte intent preimage and 196-byte handshake preimage.
                                Any change here requires lib/crypto.ts update and parity vector regeneration.
  examples/parity_vectors.rs    Rust parity vector generator — prints JSON golden vectors to stdout.
                                Regenerate fixture:
                                  cargo run -p shielded-pool-interface --example parity_vectors \
                                    > tests/fixtures/parity_vectors.json

lib/crypto.ts                   TypeScript mirror of instruction.rs — HARD FREEZE
                                Must stay in exact sync with the Rust canonical implementation.

lib/zk_indexer/
  constants.ts                  BN254 Fr modulus, domain tags, tree depth=20, empty subtree constants
  poseidon.ts                   circomlibjs Poseidon wrapper; BigInt ↔ 32-byte BE hex helpers
  incremental_tree.ts           Depth-20 in-memory incremental Merkle tree; append, root, proof, witness
  event_log.ts                  NoteDeposited normalisation, sort, replay into IncrementalMerkleTree
  persistence.ts                JSON snapshot save/load with integrity checks; event serialisation
  log_parser.ts                 EVENT_JSON log line parser; NoteDeposited fixture extraction
  rpc_adapter.ts                Read-only connection-like RPC adapter; fetch signatures/transactions; convert logs into existing indexer pipeline
  event_decoder.ts              DecodedProgramEvent boundary; EVENT_JSON decoder; EventParser-like fixture and AnchorEventParserLike DI boundary
  anchor_event_parser_adapter.ts  Real BorshCoder + EventParser adapter; constructs AnchorEventParserLike from local IDL via @anchor-lang/core

tests/
  withdraw.ts                   Withdraw happy path + security negative tests (35 tests)
  attestation_threshold.ts      Multi-signer threshold attestation tests (4 tests)
  admin_hardening.ts            Rotation, pause, replay invariant tests (12 tests)
  parity_canonical.ts           Rust ↔ TypeScript canonical hash parity gate (21 tests)
                                Run: anchor run test_parity
  migration.ts                  Migration instruction guard tests (4 tests)
                                Run: anchor run test_migration
  deposit.ts                    Deposit instruction tests (4 tests)
                                Run: anchor run test_deposit
  init_note_tree.ts             NoteTreeState initialization tests (11 tests)
                                Run: anchor run test_init_note_tree
  deposit_note.ts               ZK note deposit tests (14 tests)
                                Run: anchor run test_deposit_note
  zk_indexer_tree.ts            IncrementalMerkleTree unit tests (22 tests; no validator)
  zk_indexer_events.ts          NoteDeposited normalisation, sort, replay tests (24 tests; no validator)
  zk_indexer_persistence.ts     Snapshot save/load tests (20 tests; no validator)
  zk_indexer_fixture.ts         Fixture runner CLI tests (13 tests; no validator)
  zk_indexer_log_parser.ts      EVENT_JSON log parser and extraction tests (22 tests; no validator)
  zk_indexer_e2e.ts             End-to-end local pipeline tests (5 tests; no validator)
  zk_indexer_rpc_adapter.ts     RPC adapter unit tests (26 tests; no validator, mocked connections)
  zk_indexer_rpc_fetch.ts       RPC fetch CLI tests (77 tests; no validator, mocked connections)
  zk_indexer_event_decoder.ts   Event decoder boundary tests (23 tests; no validator, fixtures/fakes only)
  zk_indexer_anchor_event_parser_adapter.ts  Anchor EventParser adapter tests (10 tests; no validator, local IDL + base64 fixtures)
  ops_submit_root_devnet.ts     Guarded root submission script tests (55 tests; no validator, mocked deps)
  ops_inspect_allowed_roots_devnet.ts  Allowed roots inspection script tests (80 tests; no validator, mocked deps)
  ops_set_root_submitter_devnet.ts     Root-submitter rotation script tests (55 tests; no validator, mocked deps)
  fixtures/parity_vectors.json  Golden vectors generated by the Rust canonical implementation

scripts/
  run_all_tests.sh              Validator lifecycle manager — runs all 8 integration suites
  bootstrap_alpha_wallets.sh    One-time keypair generation for alpha deployment (keys/ hierarchy)
  deploy_devnet.sh              Pre-flight checked devnet deployment with explicit operator confirmation
  monitor_devnet.ts             Real-time event monitor — streams decoded events from devnet
  zk_indexer_fixture.ts         Local fixture runner CLI — reads event JSON, replays, writes snapshot
  zk_indexer_rpc_fetch.ts       Read-only RPC fetch CLI — fetches transactions via supplied RPC URL, decodes events via configurable decoder mode (event-json or anchor-event-parser), writes and verifies local snapshot; supports --dry-run to skip the write; supports --signature <sig> for exact-transaction reproducible smoke
  ops/
    export_devnet_state.ts      Read-only state snapshot: config PDA, pool PDA, program deploy slot
    check_no_secrets.sh         Secret scan: hard-fail if keypair JSON is tracked in git
    check_hard_freeze_diff.sh   CI guard: fails if any hard-freeze path was modified between BASE...HEAD; safe for local use (falls back to origin/main)
    init_note_tree_devnet.ts    One-shot NoteTreeState PDA initializer (admin-only, one transaction); supports --dry-run
    deposit_note_devnet.ts      One-shot NoteDeposited event sender (depositor wallet, bucket 1, 1,000 lamports); supports --dry-run
    submit_root_devnet.ts       Guarded root submission — loads and verifies a local indexer snapshot, then submits its root via addAllowedRoot; no-flag mode exits with safety message; --dry-run validates snapshot without RPC or wallet; --yes required to send; no deposit_note, no withdraw_zk
    inspect_allowed_roots_devnet.ts  Read-only allowed_roots inspector — reads verifier_config PDA, prints admin authority, paused state, threshold, verifier count, allowed root list, and whether --expected-root is present; no wallet required; no transactions sent; recommended verification step after root submission
    set_root_submitter_devnet.ts     Guarded root-submitter rotation — rotates root_submitter_authority via setRootSubmitterAuthority; wallet (admin_authority) only loaded in --yes mode; --dry-run previews current and proposed state without sending; no-flag mode exits with safety message; no note-deposit, no ZK withdrawal, no allowed-root calls
    shared_pool_status_devnet.ts     Read-only shared-pool status/readiness — prints profile, config/pool/note-tree PDAs, and allowed-root check; no wallet, no transactions, no root submission (npm run alpha:status)
    shared_pool_tester_deposit.ts    Guided shared-pool deposit — previews by default, --yes to send; writes the note file outside the repo (npm run alpha:deposit)
    shared_pool_tester_withdraw_simulate.ts  Guided withdraw_zk simulation — read-only preflight; no live send, no nullifier consumed (npm run alpha:withdraw:simulate)

idl/
  shielded_pool_anchor.json     Tracked IDL snapshot. Refresh after rebuild: anchor run update_idl

generated/
  devnet_program_id.txt         Written by deploy_devnet.sh after successful deployment

docs/                           Operator and security documentation
```

---

## Quickstart

### Prerequisites

- Rust 1.89+
- Solana CLI 1.18+
- Anchor CLI 1.0.1 (`avm install 1.0.1 && avm use 1.0.1`)
- Node.js 20+ and npm

### Build

```bash
npm install
anchor build
```

### Parity check

Run the Rust ↔ TypeScript canonical hash parity gate. No validator, network, or devnet
credentials required:

```bash
anchor run test_parity
```

Expected: `21 passing` (5 vectors × 4 assertions + 1 fixture load check).

Golden vectors are committed at `tests/fixtures/parity_vectors.json` and were generated by
the Rust canonical implementation (`crates/shielded-pool-interface/examples/parity_vectors.rs`).
Regenerate only when `instruction.rs` layout or domain tags change:

```bash
cargo run -p shielded-pool-interface --example parity_vectors \
  > tests/fixtures/parity_vectors.json
```

Commit the updated fixture and re-run `anchor run test_parity` to confirm.

### Run all tests

`anchor run test_all` manages validator lifecycle and runs all 8 integration suites sequentially:

```bash
anchor run test_all
```

Expected output: `All 8 suites passed.` See `scripts/run_all_tests.sh` for the current suite list.

> **Mock-verifier note:** `anchor run test_all` builds the program with `--features mock-verifier`
> for `withdraw_zk` test coverage. The resulting `target/deploy/shielded_pool_anchor.so` is
> a local-test-only artifact and must not be deployed. `scripts/deploy_devnet.sh` always
> rebuilds without this flag before any deploy and verifies the artifact with
> `scripts/ops/check_deploy_artifact_not_mock.sh`.

Do not use `anchor test` alone — it runs only `withdraw.ts` (1 of 8 integration suites).

The parity gate (`anchor run test_parity`, 21 tests) is a separate validator-free check
and is not included in this count. Run both before deploying.

### ZK real proof integration test (LiteSVM)

The real Groth16 proof integration tests require a prebuilt program artifact and are
excluded from the default `cargo test` run. To invoke them explicitly:

```bash
anchor build
cargo test --manifest-path programs/shielded_pool_anchor/Cargo.toml \
  --test litesvm_real_proof -- --ignored --nocapture
```

This runs the canonical `WITHDRAW_SOL_V1` proof path in LiteSVM and confirms the real
verifier accepts the known-good proof and rejects tampered bytes. Measured transaction
CU: approximately 119,664. Recommended devnet-alpha `SetComputeUnitLimit`: 200,000. See
[`docs/ZK_REAL_PROOF_CU_BENCHMARK.md`](docs/ZK_REAL_PROOF_CU_BENCHMARK.md) for the full
benchmark.

### ZK devnet live send smoke

The full withdrawal pipeline has been completed end-to-end on devnet. A fresh sacrificial
note was deposited, proved with a real Groth16 proof, and spent on-chain via
`withdraw_zk_devnet.ts --send`. The transaction finalized; the nullifier marker PDA was
created; pool, recipient, and relayer balances changed as expected.

The proof path — devnet snapshot fetch → witness export → `snarkjs groth16 fullprove` →
`withdraw_zk_devnet.ts --simulate` → `withdraw_zk_devnet.ts --send` — ran end-to-end with
`simulationOk: true`, `unitsConsumed: 126010`, and transaction status `Finalized`.

This path requires external proving artifacts (`.wasm` and `.zkey`) that are not committed
to the repository. The on-chain verifying key (`WITHDRAW_SOL_V1_VK`) is binary-embedded in
the program and requires no external files for verification.

**Current limits:**

- Off-chain proof generation requires external snarkjs artifacts (wasm + zkey) managed
  separately from this repository.
- Single-operator deployment. Root submitter authority, admin, and upgrade authority are
  controlled by a single operator; the allowed-roots allowlist is not trustless.
- Unaudited. This codebase has not been independently audited. Not for real funds.

See [`docs/status/devnet/2026-06-08-withdraw-zk-live-send-smoke.md`](docs/status/devnet/2026-06-08-withdraw-zk-live-send-smoke.md)
for the full live send smoke record, and
[`docs/status/devnet/2026-06-08-withdraw-zk-real-proof-smoke.md`](docs/status/devnet/2026-06-08-withdraw-zk-real-proof-smoke.md)
for the earlier simulation-only record.

### Parity vectors

Golden vectors in `tests/fixtures/parity_vectors.json` are committed and must not be
edited manually. They are generated by the Rust canonical implementation in
`crates/shielded-pool-interface/examples/parity_vectors.rs`.

Regenerate them only when the canonical hash layout or domain tags change in
`crates/shielded-pool-interface/src/instruction.rs`:

```bash
cargo run -p shielded-pool-interface --example parity_vectors \
  > tests/fixtures/parity_vectors.json
anchor run test_parity
```

Expected: `21 passing`.

See [Parity test scope](#parity-test-scope) below for what the gate verifies.

### Guided devnet alpha flow (requires deployed program)

> **Devnet only — unaudited, single-operator, no privacy guarantee. Never use real funds or real wallet addresses.**

> **Note:** Use the `npm run alpha:*` aliases (or `npx ts-node` directly) for devnet operations. `anchor run` reads `cluster = "localnet"` from `Anchor.toml` and ignores `ANCHOR_PROVIDER_URL`, so it does not hit devnet even if that variable is set.

The public tester path is the guided shared-pool flow. Status is read-only, deposit previews by default, and withdrawal is simulate-only — none of these submit roots (root submission is operator-managed):

```bash
# Check shared-pool status / readiness (read-only — no wallet, no transactions)
npm run alpha:status -- --rpc-url https://api.devnet.solana.com --json

# Preview a deposit (omit --yes); add --yes to send. The note file is written outside the repo.
npm run alpha:deposit -- --wallet <devnet-wallet> --note-output <path-outside-repo>

# Simulate a withdrawal (read-only preflight; no live send, no nullifier consumed)
npm run alpha:withdraw:simulate -- --note <path-outside-repo> --snapshot <snapshot.json> \
  --leaf-index <n> --root <64-hex-root> --recipient <pubkey> --relayer <pubkey>
```

`--recipient` and `--relayer` must be distinct pubkeys. See [`docs/DEVNET_ALPHA_TESTER_QUICKSTART.md`](docs/DEVNET_ALPHA_TESTER_QUICKSTART.md) for the full walkthrough. Operator actions — pause/unpause, verifier rotation, and allowed-root submission — are single-operator and are not part of the public tester flow.

---

## Parity test scope

`tests/parity_canonical.ts` loads golden vectors from `tests/fixtures/parity_vectors.json` and verifies that `lib/crypto.ts` produces identical preimage bytes and Keccak256 hashes.

**What it guarantees:**

- TypeScript and the Rust-computed golden vectors agree on preimage layout and hash output for all 5 tested inputs (21 assertions).

**What it does NOT guarantee:**

- That the Rust implementation (`instruction.rs`) is correct in isolation.
- That a bug present in both the Rust generator and TypeScript would be caught.

The parity test is a **cross-language consistency gate**: vectors are computed by the Rust canonical implementation and committed. If `lib/crypto.ts` silently diverges from `instruction.rs` — wrong field order, wrong encoding, wrong domain tag — this test catches it.

The parity gate does not use Python; Rust-generated fixtures and the TypeScript test are the supported workflow.

---

## Local ZK indexer pipeline

A local-only, fixture-driven indexer prototype exists in `lib/zk_indexer/`. No RPC connection, devnet, or validator is required.

**Components:**

| Module                                          | Role                                                                                                                                                                                               |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/zk_indexer/constants.ts`                   | BN254 Fr modulus, domain tags (`TAG_LEAF=2`, `TAG_NODE=3`), `TREE_DEPTH=20`, empty subtree constants                                                                                               |
| `lib/zk_indexer/poseidon.ts`                    | circomlibjs Poseidon wrapper; BigInt ↔ 32-byte BE hex conversion helpers                                                                                                                           |
| `lib/zk_indexer/incremental_tree.ts`            | Depth-20 incremental Merkle tree; `append`, `getRoot`, `getProofByCommitment`, `exportWitnessInputs`                                                                                               |
| `lib/zk_indexer/event_log.ts`                   | `NoteDeposited` normalisation, sort by leaf_index/slot/log_index, `replayNoteDeposits`                                                                                                             |
| `lib/zk_indexer/persistence.ts`                 | JSON snapshot save/load with integrity checks (root, leaf_count, event validation)                                                                                                                 |
| `lib/zk_indexer/log_parser.ts`                  | `EVENT_JSON:` log line parser; two-mode fixture extraction (`events[]` and `logs[]`)                                                                                                               |
| `lib/zk_indexer/rpc_adapter.ts`                 | Read-only `ReadOnlyConnectionLike` interface; `fetchSignaturesForAddress`, `fetchTransactionsForSignatures`, log extraction into the existing pipeline                                             |
| `lib/zk_indexer/event_decoder.ts`               | `DecodedProgramEvent` intermediate representation; `EventJsonLogDecoder` for EVENT_JSON logs; `decodeEventParserLikeFixture` for pre-parsed fixtures; `createAnchorEventParserDecoder` DI boundary |
| `lib/zk_indexer/anchor_event_parser_adapter.ts` | Real Anchor EventParser adapter; `createAnchorEventParserLikeFromIdl` / `createAnchorEventParserLogDecoderFromIdl` using `@anchor-lang/core` `BorshCoder` + `EventParser`; no RPC, no Connection   |
| `scripts/zk_indexer_fixture.ts`                 | CLI fixture runner — reads local event JSON, normalises, replays, writes snapshot; no RPC                                                                                                          |
| `scripts/zk_indexer_rpc_fetch.ts`               | CLI RPC fetch wrapper — address mode (getSignaturesForAddress) or exact-signature mode (`--signature`); decodes events, writes and verifies snapshot; supports `--dry-run`; sends no transactions  |

**Fixture runner (local JSON, no RPC):**

```bash
# Bare array input: [ { "commitment": "...", "denomination": "...", "leafIndex": N, ... } ]
npx ts-node scripts/zk_indexer_fixture.ts --input /tmp/events.json --output /tmp/snapshot.json

# Object wrapper { "events": [...] } is also accepted.

# Skip auto-sort (replay events in the order provided):
npx ts-node scripts/zk_indexer_fixture.ts --input /tmp/events.json --output /tmp/snapshot.json --no-sort
```

**RPC fetch CLI (read-only, no transactions sent):**

Two fetch modes: address mode (default) and exact-signature mode (`--signature`).
Two decoder modes via `--decoder`: `event-json` (default) and `anchor-event-parser`.

```bash
# Address mode — event-json (parses EVENT_JSON-marked log lines)
npx ts-node scripts/zk_indexer_rpc_fetch.ts \
  --rpc-url https://api.devnet.solana.com \
  --address <PROGRAM_OR_ACCOUNT_PUBKEY> \
  --output /tmp/zk-indexer-snapshot.json \
  --limit 100 \
  --commitment confirmed

# Address mode — anchor-event-parser (decodes Anchor base64 events via @anchor-lang/core BorshCoder)
npx ts-node scripts/zk_indexer_rpc_fetch.ts \
  --rpc-url https://api.devnet.solana.com \
  --address <PROGRAM_OR_ACCOUNT_PUBKEY> \
  --program-id <PROGRAM_ID_FOR_EVENT_PARSER> \
  --idl idl/shielded_pool_anchor.json \
  --decoder anchor-event-parser \
  --output /tmp/zk-indexer-snapshot.json \
  --limit 100 \
  --commitment confirmed

# Exact-signature mode — anchor-event-parser (reproducible positive smoke; --address not required)
npx ts-node scripts/zk_indexer_rpc_fetch.ts \
  --rpc-url https://api.devnet.solana.com \
  --signature <TX_SIGNATURE> \
  --program-id <PROGRAM_ID> \
  --idl idl/shielded_pool_anchor.json \
  --decoder anchor-event-parser \
  --output /tmp/zk-indexer-snapshot.json \
  --commitment confirmed \
  --dry-run
```

Fetch modes:

- **Address mode** (default) — calls `getSignaturesForAddress` then `getTransaction` for each result. Requires `--address`. Supports `--limit`, `--before`, `--until` pagination.
- **Exact-signature mode** (`--signature <sig>`) — calls `getTransaction` once for the exact signature. `--address` is not required and is rejected if provided. `--limit`, `--before`, and `--until` are also rejected. Use for reproducible exact-transaction smoke tests that are not sensitive to the "latest N" window.

Decoder flags:

- `--decoder event-json` — default; parses `EVENT_JSON:`-marked log lines.
- `--decoder anchor-event-parser` — decodes Anchor base64 events using `@anchor-lang/core` `BorshCoder` + `EventParser`; requires `--idl` and `--program-id`.
- `--idl <path>` — path to local IDL JSON file (required for `anchor-event-parser`; read from disk only, no network fetch).
- `--program-id <pubkey>` — program ID for `EventParser` construction (required for `anchor-event-parser`).

Additional flags:

- `--dry-run` — fetch, decode, sort, and build the snapshot in memory without writing `--output`.
- `--include-failed` — include logs from failed transactions (default: skip failed).
- `--no-sort` — preserve fetched event order; will fail with `expectedLeafIndex` error if events arrive out of order.
- `--before <sig>` / `--until <sig>` — pagination cursors for address mode only.
- `--help`, `-h` — print full flag usage and exit.

Run `npx ts-node scripts/zk_indexer_rpc_fetch.ts --help` for the full flag reference.

This CLI does not submit roots, does not send transactions, and does not implement `withdraw_zk`. It uses `@solana/web3.js` `Connection` and `PublicKey` only inside the CLI entry path; the core `runRpcIndexer` function accepts any `ReadOnlyConnectionLike` and is fully testable with mocked connections.

In normal write mode, the CLI reloads the written snapshot with `loadSnapshot` and verifies root/leaf_count consistency before reporting success.

Output snapshot fields: `version`, `tree_depth`, `events`, `last_root_be_hex`, `leaf_count`. Version 2 snapshots (produced by the RPC fetch CLI after the fetch provenance metadata change) additionally include a `meta` block containing: `fetch_commitment`, `source_mode`, `rpc_url` (query string stripped to avoid leaking API keys), `program_id`, `address`, `signature`, `created_at`.

For devnet smoke testing, always start with `--dry-run` and a small `--limit` (e.g. `--limit 10`). See `docs/DEVNET_ALPHA_RUNBOOK.md` §2.4 for example commands and expected output.

**Event decoding pipeline shape:**

```
Raw logs / pre-parsed { name, data } events
  → DecodedProgramEvent          (event_decoder.ts)
  → normalizeNoteDepositedEvent  (event_log.ts)
  → sortEventsForReplay          (event_log.ts)
  → replayNoteDeposits / IncrementalMerkleTree
  → snapshot / proof export
```

`lib/zk_indexer/event_decoder.ts` provides three decoding modes:

- **`EventJsonLogDecoder`** — decodes `EVENT_JSON:`-marked log lines, producing `source: "event_json_log"`. Uses `parseEventJsonLogLine` from `log_parser.ts` internally.
- **`decodeEventParserLikeFixture`** — converts already-decoded `{ name, data }[]` objects (e.g. from Anchor EventParser) into `DecodedProgramEvent[]`, `source: "event_parser_like_fixture"`. Useful for testing with fixture data.
- **`createAnchorEventParserDecoder`** — dependency-injection wrapper: accepts any `AnchorEventParserLike` object and returns a `LogDecoder`. No `@coral-xyz/anchor` or `@solana/web3.js` imported at the module level.

`lib/zk_indexer/anchor_event_parser_adapter.ts` provides the concrete `@anchor-lang/core` implementation of that DI interface. `createAnchorEventParserLikeFromIdl` and `createAnchorEventParserLogDecoderFromIdl` lazily `require('@anchor-lang/core')` inside factory functions, construct a `BorshCoder` and `EventParser` from the local IDL, and return a `LogDecoder` that decodes real Anchor base64 event log lines. No Connection is created; no RPC is used.

The existing `log_parser.ts` behavior is unchanged. Both `event_decoder.ts` and `anchor_event_parser_adapter.ts` are additive layers.

**Scope:** This layer does not subscribe to chain logs, submit roots on-chain, send transactions, or implement `withdraw_zk`. WebSocket subscription remains future work.

**Run the local indexer tests (no validator required):**

```bash
npm run test:zk-indexer
```

Or equivalently, running the full 24-file suite directly:

```bash
npx mocha -r ts-node/register --extensions ts -t 1000000 \
  tests/zk_indexer_tree.ts \
  tests/zk_indexer_events.ts \
  tests/zk_indexer_persistence.ts \
  tests/zk_indexer_fixture.ts \
  tests/zk_indexer_log_parser.ts \
  tests/zk_indexer_e2e.ts \
  tests/zk_indexer_rpc_adapter.ts \
  tests/zk_indexer_rpc_fetch.ts \
  tests/zk_indexer_event_decoder.ts \
  tests/zk_indexer_anchor_event_parser_adapter.ts \
  tests/ops_init_note_tree_devnet.ts \
  tests/ops_deposit_note_devnet.ts \
  tests/ops_submit_root_devnet.ts \
  tests/ops_inspect_allowed_roots_devnet.ts \
  tests/ops_set_root_submitter_devnet.ts \
  tests/zk_prover_witness.ts \
  tests/zk_tx_hash_parity.ts \
  tests/zk_real_fixture_shape.ts \
  tests/zk_proof_encoder_shape.ts \
  tests/zk_vk_parser_shape.ts \
  tests/zk_public_inputs_shape.ts \
  tests/zk_withdraw_artifacts.ts \
  tests/zk_withdraw_instruction.ts \
  tests/ops_withdraw_zk_devnet.ts
```

Expected: `1022 passing` (475 indexer/ops tests from the original 15-file suite + 547 ZK prover, verifier artifact, and withdraw_zk ops tests from 9 additional files). These tests run independently of the validator-backed suites and the parity gate.

---

## On-chain instructions

| Instruction                    | Signer         | Description                                                                                                                                                            |
| ------------------------------ | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize_pool`              | Payer          | Creates the pool state PDA. The signer's pubkey is stored in `pool_state.authority`, but this field is not used as an access-control check by any current instruction. |
| `initialize_config`            | Admin          | Creates verifier config PDA. The signer becomes the permanent `admin_authority`.                                                                                       |
| `update_verifier_config`       | Admin          | Rotates verifiers, updates threshold, sets pause state. Only `admin_authority` may call.                                                                               |
| `set_root_submitter_authority` | Admin          | Rotates `root_submitter_authority` to a new non-zero key. Only `admin_authority` may call. Defaults to `admin_authority` at initialization and after migration.        |
| `add_allowed_root`             | Root submitter | Adds a Merkle root to the `allowed_roots` registry. Signer account (`rootSubmitter`) must be `root_submitter_authority`.                                               |
| `remove_allowed_root`          | Root submitter | Removes a Merkle root from `allowed_roots`. Signer account (`rootSubmitter`) must be `root_submitter_authority`.                                                       |
| `withdraw`                     | Relayer        | Executes an attested intent-based withdrawal. Requires preceding Ed25519 instructions in the same transaction.                                                         |
| `deposit`                      | Any signer     | Transfers SOL into the pool PDA, updates `pool_state.total_deposits`, emits `DepositReceived`. Permissionless; allowed regardless of pause state.                      |
| `init_note_tree`               | Admin          | Creates the `NoteTreeState` PDA (seeds `[b"note_tree"]`). Admin-only. Must be called once before the first `deposit_note`.                                             |
| `deposit_note`                 | Any signer     | Transfers `denomination` lamports to pool, records commitment as the next Merkle leaf, increments `leaf_count`, emits `NoteDeposited`. Blocked when paused.            |

---

## Error surface

All errors are deterministic. Error codes are stable identifiers used in monitoring and tests — do not change or renumber them.

| Error                     | Meaning                                                      |
| ------------------------- | ------------------------------------------------------------ |
| `Paused`                  | Protocol is paused by admin                                  |
| `InvalidChainId`          | Intent chain_id ≠ config chain_id                            |
| `SettlementExpired`       | Current slot > expiry_slot                                   |
| `InvalidAmount`           | Amount is zero                                               |
| `InvalidFee`              | Fee exceeds amount                                           |
| `FeeTooLow`               | Fee below nullifier marker rent                              |
| `InsufficientPoolBalance` | Pool lacks SOL for withdrawal                                |
| `NullifierAlreadyUsed`    | Nullifier already consumed                                   |
| `AttestationFailed`       | Not enough unique authorized signers                         |
| `Unauthorized`            | Relayer ≠ intent.relayer (enforced by Anchor constraint)     |
| `BindingMismatch`         | Recipient ≠ intent.recipient (enforced by Anchor constraint) |
| `UnauthorizedAdmin`       | Signer ≠ config.admin_authority                              |
| `InvalidThreshold`        | threshold = 0 or > verifier count                            |
| `DuplicateVerifier`       | Duplicate pubkey in verifier set                             |
| `TooManyVerifiers`        | Exceeds MAX_VERIFIERS (8)                                    |
| `EmptyVerifierSet`        | Verifier list is empty                                       |
| `DefaultVerifierKey`      | All-zero pubkey in verifier set                              |
| `InvalidDepositAmount`    | Deposit amount is zero                                       |
| `InvalidCommitment`       | Commitment is the zero element (reserved as invalid)         |
| `NonCanonicalCommitment`  | Commitment ≥ BN254 Fr modulus                                |
| `InvalidDenomination`     | Denomination not in `ALLOWED_BUCKET_AMOUNTS`                 |
| `TreeFull`                | Note tree is at capacity (`leaf_count >= 1 << tree_depth`)   |
| `InvalidTreeDepth`        | `NoteTreeState.tree_depth` ≠ `NOTE_TREE_DEPTH` (20)          |

---

## IDL

A tracked IDL snapshot is in `idl/shielded_pool_anchor.json`. To refresh after a program rebuild:

```bash
anchor build
anchor run update_idl
```

---

## Alpha status

- **Unaudited.** This codebase has not been independently audited.
- **Single-operator.** The verifier committee and admin authority are controlled by one party.
- **Not production privacy.** The `withdraw_zk` path verifies a real Groth16 proof, but this is still a devnet-alpha prototype. Real privacy depends on anonymity set, denomination discipline, relayer behavior, and operational setup. The plain `withdraw` path has plaintext parameters.
- **Devnet only.** Do not use with real funds. Solana devnet resets periodically, destroying all on-chain state.

---

## CI hard-freeze guard

`scripts/ops/check_hard_freeze_diff.sh` is the first CI step on every push and pull request. It compares `BASE...HEAD` (merge-base form) and fails if any file under a frozen path was modified:

- `programs/` — on-chain Rust source
- `crates/` — canonical hash implementation (`instruction.rs`)
- `lib/crypto.ts` — TypeScript mirror of the canonical hash
- `tests/fixtures/parity_vectors.json` — committed golden parity vectors
- `Anchor.toml`, `Cargo.toml`, `Cargo.lock` — build configuration

Normal commits that do not touch these paths pass automatically with no action required.

**Intentional on-chain changes** (program upgrades, canonical hash changes, new parity vectors) require an explicit override to acknowledge the frozen-path modification:

- **Pull request:** add the `freeze-ok` label to the PR before CI runs (or re-run after labelling).
- **Direct push to main:** include `[freeze-ok]` in the head commit message.

When the override is active, CI prints the frozen-file violation list followed by:

```
Hard-freeze changes allowed by explicit override.
```

and exits 0. All other CI steps — lint, type-check, ZK indexer tests, parity gate, Rust unit tests — still run. The override only acknowledges the frozen-path change; it does not bypass any quality checks.

See `docs/FREEZE_MATRIX.md` for the rationale behind each frozen path.

---

## License

ISC — see [LICENSE](LICENSE).
