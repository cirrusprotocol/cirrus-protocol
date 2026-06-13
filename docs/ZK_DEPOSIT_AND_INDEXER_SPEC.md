# ZK Deposit and Merkle Tree Indexer Spec

> **Scope:** This document covers the `deposit_note` instruction, the `NoteTreeState` PDA,
> the `NoteDeposited` event schema, and the off-chain Merkle tree indexer for the shielded
> pool ZK extension. It originated as a pre-implementation spec gate and now serves as an
> implementation-aligned scaffold for the deposit and indexer subsystems.
>
> **Current status (2026-06-08):** The on-chain `deposit_note` instruction and local indexer
> pipeline are implemented. The `withdraw_zk` instruction and real Groth16 verifier are also
> implemented and deployed on devnet — they are no longer out of scope or future work. Root
> submission is implemented in `scripts/ops/submit_root_devnet.ts`. A real-proof simulation
> and a guarded live `withdraw_zk --send` have both succeeded on devnet. WebSocket
> subscription remains future work. See
> [`status/devnet/2026-06-08-withdraw-zk-real-proof-smoke.md`](status/devnet/2026-06-08-withdraw-zk-real-proof-smoke.md)
> and
> [`status/devnet/2026-06-08-withdraw-zk-live-send-smoke.md`](status/devnet/2026-06-08-withdraw-zk-live-send-smoke.md).
>
> This document covers the Phase 3 deposit and indexer specification. Phase 1 (Poseidon
> feasibility) and Phase 2 (off-chain circuit prototype) are complete. The local indexer
> scaffold (Phases 3.1–3.4) is implemented through the Anchor EventParser adapter boundary.

---

## 1. Locked ZK Context

The following parameters were fixed in Phase 1 and Phase 2. They must not be changed without re-running the full feasibility and circuit validation pipeline.

### Public inputs

```
[root, nullifier_hash, tx_hash]
```

These are the three BN254 Fr elements exposed as public inputs to the Groth16 verifier. Their order in `public.json` and in the on-chain IC accumulation is:

| Index | Signal           |
| ----- | ---------------- |
| IC[0] | constant term    |
| IC[1] | `root`           |
| IC[2] | `nullifier_hash` |
| IC[3] | `tx_hash`        |

### Domain tags

| Tag             | Value |
| --------------- | ----- |
| `TAG_NULLIFIER` | 1     |
| `TAG_LEAF`      | 2     |
| `TAG_NODE`      | 3     |
| `TAG_TX`        | 4     |
| `TAG_TX_INNER`  | 5     |

### Hash constructions

```
note_leaf      = Poseidon(TAG_LEAF,     secret, denomination)
nullifier_hash = Poseidon(TAG_NULLIFIER, secret)

pubkeys_hash   = Poseidon(TAG_TX_INNER,
                   program_id_lo, program_id_hi,
                   pool_pda_lo,   pool_pda_hi,
                   config_pda_lo, config_pda_hi,
                   recipient_lo,  recipient_hi,
                   relayer_lo,    relayer_hi)

tx_hash        = Poseidon(TAG_TX,
                   pubkeys_hash,
                   denomination,
                   fee,
                   chain_id,
                   expiry_slot,
                   circuit_version)
```

Pubkey split convention: for any 32-byte Ed25519/BN254-domain public key `pk`, `pk_lo` is `pk[0..16]` interpreted as a 128-bit little-endian integer, and `pk_hi` is `pk[16..32]` interpreted as a 128-bit little-endian integer. Both are serialized as 32-byte big-endian BN254 Fr elements for hashing.

### Poseidon parameters

`light-poseidon 0.4.0` with `Poseidon::<Fr>::new_circom(n)`. This targets circomlib parameter compatibility. Confirmed equivalent to `circomlibjs 0.1.7` `buildPoseidon()` and `circomlib 2.0.5` `Poseidon(n)` WASM output, byte-for-byte, for all tested arities.

### Tree parameters

| Parameter                  | Value                                         |
| -------------------------- | --------------------------------------------- |
| Depth                      | 20                                            |
| Capacity                   | `1 << 20` = 1,048,576 leaves                  |
| Empty leaf                 | `Poseidon(TAG_LEAF, 0, 0)`                    |
| Empty subtree at depth `i` | `Poseidon(TAG_NODE, empty[i-1], empty[i-1])`  |
| Node hash                  | `Poseidon(TAG_NODE, left_child, right_child)` |

### Root registry

`config.allowed_roots` is the sole on-chain authoritative root registry. `withdraw_zk` (Phase 4) must reject any `root` not present in this list. The list is maintained by the admin (MVP) via the existing root-management instructions.

---

## 2. deposit_note Instruction Spec

### Purpose

`deposit_note` is the ZK entry point for the shielded pool. It accepts a BN254 Fr commitment (the note leaf hash computed off-chain by the depositor) and records it as the next leaf in the Merkle tree. It is distinct from the existing `deposit` instruction, which is the non-ZK path. Both coexist for MVP.

### Accounts

| Account           | Role                                               | Writable | Signer |
| ----------------- | -------------------------------------------------- | -------- | ------ |
| `depositor`       | Transaction payer; holds the note secret off-chain | Yes      | Yes    |
| `pool_state`      | Pool PDA; receives `denomination` lamports         | Yes      | No     |
| `note_tree_state` | `[b"note_tree"]` PDA; leaf counter                 | Yes      | No     |
| `system_program`  | Required for lamport CPI transfer                  | No       | No     |

### Arguments

| Argument       | Type       | Description                                                                             |
| -------------- | ---------- | --------------------------------------------------------------------------------------- |
| `commitment`   | `[u8; 32]` | Note leaf hash: `Poseidon(TAG_LEAF, secret, denomination)`, 32-byte big-endian BN254 Fr |
| `denomination` | `u64`      | Deposit amount in lamports; must be an element of `ALLOWED_BUCKET_AMOUNTS`              |

### Required Checks (in order)

1. **Protocol not paused.** Check `config.paused`; reject with `Paused` if true. (`deposit` does not check pause — `deposit_note` is the ZK entry path and is blocked during pause so that note commitments are not trapped in a tree with no withdraw path.)

2. **Denomination is in `ALLOWED_BUCKET_AMOUNTS`.** Reject any value outside the configured bucket set.

3. **Commitment is non-zero.** Reject `commitment == [0u8; 32]`. Zero is a canonical BN254 Fr element, but it is reserved as an invalid note commitment by protocol policy. This prevents sentinel/default values from entering the tree.

4. **Commitment is canonical BN254 Fr.** The 32-byte big-endian representation must be strictly less than the BN254 Fr modulus:

   ```
   0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001
   ```

   Perform a byte-by-byte big-endian comparison. Reject with a descriptive error if the commitment is out of range. This prevents non-canonical field elements from being inserted as leaves, which would produce a leaf hash the circuit cannot match.

5. **Tree not full.** Let `capacity = 1u64 << note_tree_state.tree_depth`. Require `note_tree_state.leaf_count < capacity`. Error: `TreeFull`.

6. **Transfer lamports.** CPI to `system_program` transferring exactly `denomination` lamports from `depositor` to `pool_state`. The pool's post-transfer lamport balance must remain above its rent-exempt minimum.

7. **Update accounting.** Increment `pool_state.total_deposits` by `denomination`. No deposit-side protocol fee is applied (see §3).

8. **Assign leaf index and increment counter.**

   ```
   let leaf_index = note_tree_state.leaf_count;
   note_tree_state.leaf_count = note_tree_state.leaf_count
       .checked_add(1)
       .ok_or(ShieldedPoolError::TreeFull)?;
   ```

   The last valid `leaf_index` is `capacity - 1`. The `checked_add` provides overflow safety beyond the `leaf_count < capacity` guard.

9. **Emit `NoteDeposited` event** (see §4).

All steps execute atomically within the single instruction. There is no commitment uniqueness check on-chain. If a depositor submits the same commitment twice, two leaves are inserted with identical values. Both produce the same `nullifier_hash`. The nullifier PDA created on first withdrawal prevents the second withdrawal from succeeding. The duplicate note is effectively unspendable but does not corrupt the tree.

### Fee Model

For MVP, `deposit_note` has no deposit-side protocol fee. The amount transferred to the pool equals `denomination` exactly. The note leaf commitment encodes:

```
note_leaf = Poseidon(TAG_LEAF, secret, denomination)
```

where `denomination` is the full deposited amount.

Withdrawal fee is charged only at `withdraw_zk` settlement time as a split inside `denomination`:

```
pool debit        = denomination
recipient credit  = denomination - fee
relayer credit    = fee
```

The prover commits to `fee` in the `tx_hash` circuit preimage. The on-chain verifier (Phase 4) will check that the declared `fee` and `denomination` match the submitted proof. This design ensures `denomination` carries the same value from deposit leaf through circuit constraint through on-chain verification, with no ambiguity about what was committed.

---

## 3. NoteTreeState PDA

### Seeds and derivation

```
seeds: [b"note_tree"]
program: shielded_pool_anchor
```

A single tree holds commitments for all denomination buckets. This simplifies the indexer, provides one root registry, and lets all deposits share the same tree history. However, because denomination is public in MVP, the effective anonymity set remains denomination-scoped, not global across all deposits.

### Account layout

```rust
pub struct NoteTreeState {
    pub leaf_count: u64,      // next free leaf index; monotonically increasing
    pub tree_depth: u8,       // fixed at 20; stored for runtime verification
    pub bump: u8,             // PDA bump
    pub padding: [u8; 6],     // alignment to 8-byte boundary
}
```

### Size convention

`NoteTreeState::LEN` follows the same convention as all other account types in this
program: it **includes** the 8-byte Anchor discriminator. This matches the codebase
pattern (`PoolState::LEN`, `NullifierMarker::LEN`, `VerifierConfig::LEN`). This is a
naming convention correction from the original draft; the total byte allocation (24 bytes)
is unchanged.

```
NoteTreeState::LEN = DISCRIMINATOR_SIZE   // 8 — Anchor discriminator
                   + 8                    // leaf_count: u64
                   + 1                    // tree_depth: u8
                   + 1                    // bump: u8
                   + 6                    // padding: [u8; 6]
                   = 24 bytes
```

Payload bytes (fields only, excluding discriminator): 16.

Account init space (passed to `init` constraint):

```
space = NoteTreeState::LEN   // 24; discriminator already included
```

### Rent

The rent-exempt lamport requirement must be computed at runtime using:

```
Rent::minimum_balance(NoteTreeState::LEN)
```

Do not embed a fixed SOL figure in documentation or code; the rent schedule can change.

### No latest_root field

`NoteTreeState` does not store a root. Computing the correct root on-chain would require access to all committed leaves, which the program does not have. Root information lives in two places:

- **Off-chain**: the indexer's computed tree state.
- **On-chain (authoritative)**: `config.allowed_roots`, maintained by the root-submitter.

### Initialization

`NoteTreeState` is created by a dedicated `init_note_tree` instruction, signed by the admin, before the first `deposit_note` call. It initializes `leaf_count = 0`, `tree_depth = 20`, and stores the PDA bump. `deposit_note` must not create the PDA implicitly; requiring prior initialization via a separate admin instruction enforces intentional deployment.

### Why not modify PoolState

`PoolState` owns pool accounting, pause semantics, verifier configuration, and fee parameters. Embedding tree state into it would couple unrelated state machines, grow a frequently-written hot account, and require a migration instruction for any existing deployed instance. A separate PDA avoids all three.

---

## 4. NoteDeposited Event

```rust
#[event]
pub struct NoteDeposited {
    pub commitment:   [u8; 32],
    pub denomination: u64,
    pub leaf_index:   u64,
    pub depositor:    Pubkey,
    pub slot:         u64,
}
```

| Field          | Description                                                          |
| -------------- | -------------------------------------------------------------------- |
| `commitment`   | The 32-byte big-endian BN254 Fr leaf hash submitted by the depositor |
| `denomination` | Lamport amount transferred; equals the note denomination             |
| `leaf_index`   | Position assigned to this commitment in the depth-20 Merkle tree     |
| `depositor`    | Public key of the transaction signer                                 |
| `slot`         | Current slot at emission time; used for event ordering in replay     |

### Privacy notice

`depositor` is included for auditability and indexer convenience. This does not materially worsen on-chain privacy: the transaction signer's public key is already visible in Solana transaction account metadata regardless of what the program emits. **MVP `deposit_note` does not provide depositor privacy.** The deposit-to-withdrawal link is hidden by the ZK proof at withdrawal time, not by omitting the depositor from the event. Operators and integrators must not document or imply that calling `deposit_note` hides the depositor's identity.

### leaf_index authority

The `leaf_index` emitted in the event is the authoritative position for this commitment in the tree. The indexer must use this field directly and must not maintain an independent counter that it compares against the event. See §6 for indexer gap-detection protocol.

---

## 5. deposit vs deposit_note

Both instructions coexist for MVP. They serve different paths through the protocol.

| Property                                | `deposit` (existing) | `deposit_note` (new)                       |
| --------------------------------------- | -------------------- | ------------------------------------------ |
| Transfers lamports                      | Yes                  | Yes                                        |
| Updates `total_deposits`                | Yes                  | Yes                                        |
| Checks denomination bucket              | **No**               | Yes                                        |
| Checks pause                            | **No**               | Yes                                        |
| Amount/denomination constraint          | `amount > 0`         | `denomination` in `ALLOWED_BUCKET_AMOUNTS` |
| Emits event                             | `DepositReceived`    | `NoteDeposited`                            |
| Creates ZK note commitment              | No                   | Yes                                        |
| Increments `leaf_count`                 | No                   | Yes                                        |
| Commitment canonical check              | N/A                  | Yes (non-zero, BN254 Fr canonical)         |
| Requires `NoteTreeState` account        | No                   | Yes                                        |
| Requires `VerifierConfig` account       | No                   | Yes (for pause check)                      |
| Compatible with `withdraw` (existing)   | Yes                  | No                                         |
| Compatible with `withdraw_zk` (Phase 4) | No                   | Yes                                        |
| Deposit-side fee                        | None                 | None for MVP                               |

The two instructions are **not** symmetric in validation: `deposit` is fully permissionless (no pause check, no denomination bucket check) while `deposit_note` checks both. This matches the actual Rust implementation. The instructions do not share validation helpers; they have independent handlers.

The existing `deposit` instruction is not modified by Phase 3. No existing tests are affected.

---

## 6. Merkle Tree Indexer Spec

The Merkle tree exists only off-chain. The indexer is the sole entity that maintains the full leaf array, computes tree roots, and generates Merkle paths for provers.

### Responsibilities

**Event ingestion**: Subscribe to `NoteDeposited` events emitted by the program. Events must be processed in `leaf_index` order.

**Leaf insertion**: Insert each commitment at position `event.leaf_index` in the depth-20 tree. Unoccupied positions hold the empty leaf value `empty[0]` = `Poseidon(TAG_LEAF, 0, 0)`.

**Incremental root computation**: After inserting a commitment at index `i`, recompute the path from leaf `i` to the root — exactly 20 Poseidon hashes. The full tree does not need to be recomputed on each insertion.

**Empty subtree constants**: The full `empty[0..20]` chain from Phase 1 and Phase 2 is embedded as compile-time constants. Empty subtree nodes at positions that have never been populated are never recomputed from scratch.

**Parent node computation**: All interior nodes are computed as:

```
Poseidon(TAG_NODE, left_child, right_child)
```

**Merkle path generation**: On request from a prover, the indexer returns:

- `path_elements[20]`: sibling hash at each level, bottom (leaf level) to top (root level)
- `path_indices[20]`: `0` if the current node is the left child at that level, `1` if it is the right child
- `root`: the tree root at the moment the path was generated

This output is passed directly as circuit witnesses to `ShieldedWithdraw(20)`.

**Persistence**: The indexer persists at minimum the full ordered leaf array to disk after every insertion or every N insertions with a write-ahead log. On restart, the tree state is rebuilt from the persisted leaf array and any missed events are backfilled before resuming live ingestion.

### Gap detection and deduplication

The indexer must enforce that `event.leaf_index` equals the local `leaf_count` at the moment of processing:

- If `event.leaf_index == local_leaf_count`: insert, increment local counter.
- If `event.leaf_index < local_leaf_count`: duplicate delivery. Verify the stored commitment at that index matches; log a warning; do not re-insert.
- If `event.leaf_index > local_leaf_count`: gap detected. Pause live ingestion. Backfill the missing range using the historical replay path. Resume only after the gap is closed.

The indexer must never silently skip or synthesize a leaf.

### Data sources

| Source                                         | Use case                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| Anchor event subscription (WebSocket)          | Primary real-time ingestion                                            |
| `getSignaturesForAddress` + `getTransaction`   | Historical replay and backfill on restart                              |
| Raw transaction log parsing                    | Fallback when event subscription is unavailable                        |
| Account polling (`note_tree_state.leaf_count`) | Fallback only; detects new deposits but cannot recover commitment data |

The indexer should treat events as final only after sufficient confirmation depth. The finality policy for this deployment is documented in `docs/indexer_finality_policy.md`; the decision is closed for the current devnet alpha.

### Indexer state model

The minimal persistent state is:

```
leaves:     ordered array of [u8; 32], one per inserted commitment
leaf_count: u64, equals leaves.length
last_slot:  u64, slot of the last processed event
last_sig:   transaction signature of the last processed event
```

Interior nodes can be recomputed from `leaves` on restart. Caching interior nodes is a performance optimisation, not a correctness requirement.

### Local indexer pipeline — current implementation status

The following local-only prototype implements the full normalise → sort → replay → snapshot → proof pipeline. It operates entirely on fixture data; no RPC, devnet, or validator is required.

**Currently implemented:**

- Parse Anchor EventParser-like fixtures (`{ name, data }`)
- Parse `EVENT_JSON:`-marked log lines (`Program log: EVENT_JSON:{...}`)
- Normalise `NoteDeposited` payloads (commitment, denomination, leaf_index, depositor, slot, log_index)
- Sort events by leaf_index / slot / log_index
- Replay sorted events into a depth-20 Poseidon Merkle tree
- Save and load JSON snapshots with integrity checks (root recomputation, leaf_count, event validation)
- Export Merkle proofs and circuit witness inputs (`path_elements_be_hex`, `path_indices`, `root_be_hex`)
- Verify proof root recomputation in tests
- Read-only connection-like RPC adapter (`lib/zk_indexer/rpc_adapter.ts`): `ReadOnlyConnectionLike` interface, `getSignaturesForAddress` / `getTransaction` wrappers, transaction log extraction into `TransactionEventFixture`, full pipeline orchestration via `fetchAndExtractNoteDepositedEvents`
- Read-only RPC fetch CLI (`scripts/zk_indexer_rpc_fetch.ts`): two fetch modes — address mode (default, `getSignaturesForAddress` + `getTransaction`) and exact-signature mode (`--signature <sig>`, calls `getTransaction` directly, rejects `--address`/`--limit`/`--before`/`--until`); configurable decoder pipeline (`event-json` or `anchor-event-parser`); `--dry-run` builds snapshot in memory only; normal write mode writes and verifies snapshot; sends no transactions; `anchor-event-parser` mode uses `createAnchorEventParserLogDecoderFromIdl` with a local IDL path and program ID; write mode produces version 2 snapshots with a `meta` block recording fetch provenance (`fetch_commitment`, `source_mode`, `rpc_url`, `program_id`, `address`, `signature`, `created_at`); version 1 snapshots (no meta) remain loadable
- `DecodedProgramEvent` intermediate representation (`lib/zk_indexer/event_decoder.ts`): decouples raw log / fixture input from the normalisation pipeline
- `EventJsonLogDecoder`: decodes `EVENT_JSON:`-marked log lines into `DecodedProgramEvent[]` (`source: "event_json_log"`); reuses `parseEventJsonLogLine` from `log_parser.ts`
- `decodeEventParserLikeFixture`: converts already-decoded `{ name, data }[]` objects into `DecodedProgramEvent[]` (`source: "event_parser_like_fixture"`)
- `createAnchorEventParserDecoder`: dependency-injection boundary that wraps any `AnchorEventParserLike` into a `LogDecoder` without importing `@coral-xyz/anchor` at the module level
- `lib/zk_indexer/anchor_event_parser_adapter.ts`: concrete `@anchor-lang/core` implementation of that DI boundary; `createAnchorEventParserLikeFromIdl` / `createAnchorEventParserLogDecoderFromIdl` lazily require `@anchor-lang/core`, construct a `BorshCoder` and `EventParser` from the local IDL, and return a `LogDecoder` that decodes real Anchor base64 event log lines; no Connection, no RPC
- Full decoded-event → raw note → `normalizeNoteDepositedEvent` flow via `extractNoteDepositedEventsFromDecodedEvents` and `extractNoteDepositedEventsFromEventJsonLogs`

The existing `log_parser.ts` behavior is unchanged. `event_decoder.ts` and `anchor_event_parser_adapter.ts` are additive parallel layers.

**Not yet implemented:**

- Chain log subscription (WebSocket)
- On-chain root submission
- `withdraw_zk` instruction (Phase 4)

**Test suites (no validator required):**

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
  tests/ops_set_root_submitter_devnet.ts
```

Expected: `492 passing` (22 tree + 24 events + 25 persistence + 13 fixture + 22 log_parser + 5 e2e + 26 rpc_adapter + 89 rpc_fetch + 23 event_decoder + 10 anchor_event_parser_adapter + 16 ops_init_note_tree_devnet + 27 ops_deposit_note_devnet + 55 ops_submit_root_devnet + 80 ops_inspect_allowed_roots_devnet + 55 ops_set_root_submitter_devnet).

---

## 7. Root Submission Policy

### MVP cadence

A root is submitted to `config.allowed_roots` after every **10 deposits** or after a wall-clock interval of **60 minutes**, whichever fires first. The root-submitter fetches the current tree root from the indexer at the trigger point, signs and submits the add-root transaction, and records the `leaf_count` at which the root was computed.

This cadence is a starting point, not a protocol parameter. Operators may adjust it based on observed deposit volume.

### Root retention

`config.allowed_roots` uses FIFO retention with `MAX_ROOTS = 10`. When the list is at capacity and a new root must be added, the oldest root is removed first. The retained set covers roughly the last 10 submitted batches. In high-volume conditions this may correspond to approximately 100 deposits; in time-triggered low-volume conditions it may correspond to approximately 10 hours. **Neither figure is a protocol guarantee.** The actual coverage window depends on deposit volume and the operator's submission cadence.

### Effect of root pruning

If a root is evicted by FIFO rotation before a user submits their withdrawal:

- `withdraw_zk` returns `UnknownMerkleRoot`.
- The user's note is not lost. The secret is still valid.
- The user must generate a new proof using a currently-allowed root that covers their `leaf_index`.
- Any root submitted after the user's deposit, and still present in `allowed_roots`, is sufficient — the Merkle path from the user's leaf to a later root is a valid membership proof.

Operators must document the expected root coverage window clearly so users can plan their withdrawal timing.

### Root submission authority

**Implemented**: `VerifierConfig` now has a dedicated `root_submitter_authority` field. The `addAllowedRoot` and `removeAllowedRoot` instructions require the `rootSubmitter` signer to be `root_submitter_authority`. The admin can rotate this key via `setRootSubmitterAuthority`. At initialization and after migration, `root_submitter_authority` defaults to `admin_authority`, preserving existing single-operator behavior. A dedicated hot key for the root-submitter service can be set without changing the admin key. See §12 for the closed status of this open decision.

---

## 8. Root Lifecycle and Fail-Closed Policy

### Authoritative registry

`config.allowed_roots` is the sole on-chain authoritative root registry. `withdraw_zk` (Phase 4) must:

- Reject with `NoAllowedRootsConfigured` if `allowed_roots` is empty.
- Reject with `UnknownMerkleRoot` if the submitted root is not present in `allowed_roots`.

Both checks are fail-closed. There is no fallback or default root.

### Wrong roots

A root submitted to `allowed_roots` that does not correspond to the actual tree state is inert from a soundness perspective: valid provers cannot generate a Groth16 membership proof for a root that was not computed from real committed leaves. However, a wrong root occupies a slot in the fixed-size registry and creates operator confusion. The root-submitter must verify each submitted root against the indexer before signing the transaction. Monitoring must alert if a root is found in `allowed_roots` that the indexer does not recognise.

### Pruning timing

The root-submitter must not remove a root from `allowed_roots` until it is no longer the basis for any pending proof in flight. Because the protocol has no mechanism to track pending proofs, the FIFO policy (oldest root removed last, after the list fills) provides a practical approximation. Manual root removal by the admin should be used only when a root is known to be incorrect.

---

## 9. Privacy Reality Check

The following properties are accurate for MVP. Documentation, user guides, and operator materials must reflect them precisely.

**Not hidden by MVP:**

- The depositor's identity. `deposit_note` is a normal Solana transaction; the signer is public.
- The denomination. It appears in the `NoteDeposited` event and in the `tx_hash` circuit preimage.
- The recipient's address. The `withdraw_zk` instruction (Phase 4) takes `recipient` as an account argument visible on-chain.
- The relayer's address.
- The aggregate deposit count (`leaf_count` in `NoteTreeState` is a public account field).

**Hidden by MVP (conditional on operational hygiene):**

The link between a specific deposit and a specific withdrawal. If the depositor and the withdrawing party use different wallets, wait a meaningful time between deposit and withdrawal, and use a relayer, an on-chain observer cannot directly associate the two transactions.

**Effective anonymity set:**

Notes with the same denomination inserted into the tree under roots that are currently in `allowed_roots`. The set is **not** global across all denominations or all deposits in history — only deposits visible to a valid `root` in the current allowed set contribute.

**Factors that reduce the effective anonymity set:**

- Low deposit volume (extreme: a single deposit in the tree provides no anonymity).
- Frequent root rotation with small batch sizes (each root covers fewer deposits).
- Timing correlation between deposit and withdrawal.
- Unique denomination choice in a low-volume bucket.
- Relayer reuse (a single relayer can observe timing even if the on-chain state cannot link the transactions).
- Unusual behavioral fingerprints (deposit and withdrawal amounts, timing, relayer selection).

Fixed denomination buckets help by making notes of the same denomination indistinguishable by amount. They do not eliminate timing or behavioral correlation.

---

## 10. Failure Modes

| Failure                                     | Impact                                                                                                                           | Mitigation                                                                                                                               |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Indexer misses event                        | `leaf_index` gap; tree state corrupted if gap is not caught                                                                      | Gap detection by comparing `event.leaf_index` to `local_leaf_count`; pause on gap; backfill via `getSignaturesForAddress`                |
| Duplicate event delivery                    | Re-insertion at same index                                                                                                       | Deduplicate by `leaf_index`; verify stored commitment matches; log warning                                                               |
| `leaf_index` gap                            | Missing leaf produces incorrect subtree hashes above the gap                                                                     | Same as "misses event"; indexer must not proceed past a gap                                                                              |
| RPC fork / reorg                            | Events from orphaned blocks processed; incorrect commitments inserted                                                            | Wait for finality confirmation depth before treating events as final; re-validate after finalization                                     |
| Root submitted before indexer is caught up  | Root reflects an earlier `leaf_count`; users with newer deposits cannot prove under that root                                    | Root-submitter must confirm indexer `leaf_count` matches chain `leaf_count` before signing root submission                               |
| Root pruned before user withdraws           | `UnknownMerkleRoot` on withdrawal                                                                                                | User re-proves under a current root; requires secret still available and at least one current root covering the user's `leaf_index`      |
| Malformed commitment (> Fr modulus)         | Rejected by on-chain canonical Fr check                                                                                          | Instruction check prevents insertion                                                                                                     |
| Zero commitment                             | Rejected by non-zero check                                                                                                       | Instruction check prevents insertion                                                                                                     |
| User loses note secret                      | Note permanently unspendable; lamports locked                                                                                    | Protocol cannot recover; users must back up secrets before depositing                                                                    |
| Duplicate commitment deposit                | Two leaves with identical values; both produce the same nullifier                                                                | Only one withdrawal succeeds; second rejected by nullifier PDA; duplicate leaf is unspendable but does not corrupt the tree              |
| Wrong root submitted by admin               | Inert from soundness perspective; occupies registry slot                                                                         | Root-submitter verifies root against indexer before signing; monitoring alerts on unrecognised roots                                     |
| `allowed_roots` empty                       | All ZK withdrawals fail with `NoAllowedRootsConfigured`                                                                          | Monitoring alert on empty list; at least one valid root must always be present                                                           |
| Root registry full (`MAX_ROOTS = 10`)       | Root submission fails if no slot available                                                                                       | Root-submitter prunes oldest root before adding new one; alert when list reaches capacity − 2                                            |
| Admin / root-submitter key operational risk | Compromised admin key can submit wrong roots or drain config; compromised root-submitter key (once added) can submit wrong roots | Separate `root_submitter` authority before serious deployment; hardware key management for admin; monitoring for unexpected root changes |

---

## 11. Future Tests

The following tests must be implemented before Phase 3 code is merged. They are listed here as a test plan; no implementation is part of this document.

**`init_note_tree` instruction:**

- Initialises `leaf_count = 0`, `tree_depth = 20`, `bump` set correctly.
- Fails if called by a non-admin signer.
- Fails if PDA already exists.

**`deposit_note` instruction:**

- Valid commitment, valid denomination, sufficient balance → succeeds and emits `NoteDeposited`.
- Invalid denomination (not in `ALLOWED_BUCKET_AMOUNTS`) → rejected.
- Zero commitment (`[0u8; 32]`) → rejected.
- Non-canonical commitment (≥ Fr modulus) → rejected.
- Protocol paused → rejected.
- Tree full (`leaf_count == capacity`) → rejected with `TreeFull`.
- `leaf_count` increments by exactly 1 per successful deposit.
- `total_deposits` increments by `denomination` per successful deposit.
- No deposit-side fee is deducted.
- Sequential deposits emit `leaf_index` values 0, 1, 2, … N in order.
- `depositor` in emitted event matches the transaction signer.

**Indexer:**

- Indexer processing N sequential `NoteDeposited` events in order produces a Merkle root that matches the root computed independently using the Phase 1/2 empty subtree constants.
- Merkle path for `leaf_index = 0` in a single-deposit tree matches the Phase 2 circuit fixture values.
- Indexer detects `leaf_index` gap, pauses, and recovers correctly after backfill.
- Duplicate event delivery does not alter the stored commitment or the computed root.
- Indexer restart from persisted state continues correctly from the last `leaf_count`.

**Root lifecycle (integration, Phase 4 prerequisite):**

- Root submitted after N deposits → root appears in `config.allowed_roots`.
- `withdraw_zk` with a proof for a submitted root → succeeds (Phase 4 test).
- `withdraw_zk` with a proof for a pruned root → `UnknownMerkleRoot` (Phase 4 test).
- `allowed_roots` empty → `NoAllowedRootsConfigured` (Phase 4 test).

---

## 12. Open Decisions

The following decisions are not yet closed and must be resolved before or during implementation.

| Decision                                    | Status                                         | Notes                                                                                                                                                                                                                                              |
| ------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reorg finality depth for indexer            | Closed — see `docs/indexer_finality_policy.md` | `confirmed` for the devnet alpha; `finalized` for any deployment with real value; `processed` never for operator root registration                                                                                                                    |
| `root_submitter` authority as separate role | **Closed — implemented**                       | `root_submitter_authority` field added to `VerifierConfig`; `setRootSubmitterAuthority` instruction added; `addAllowedRoot`/`removeAllowedRoot` now require `root_submitter_authority` signer; defaults to `admin_authority` on init and migration |
| Indexer event source selection              | Open (implementation detail)                   | Anchor event subscription vs. log parsing; no protocol impact                                                                                                                                                                                      |
| Indexer persistence format                  | Open (implementation detail)                   | Bincode, SQLite, or key-value store; no protocol impact                                                                                                                                                                                            |

All protocol-level decisions that gate `deposit_note` and `NoteTreeState` implementation are closed.

---

## 13. Implementation Status

**Phase 3 scaffold is implemented.** This section previously served as a pre-implementation gate; it now records current status and remaining work.

**Implemented (Phase 3 scaffold):**

1. `init_note_tree` instruction and tests.
2. `deposit_note` instruction and tests.
3. Local indexer pipeline through the Anchor EventParser adapter boundary (see §6 implementation status); `anchor_event_parser_adapter.ts` provides real `BorshCoder`/`EventParser` integration using the local IDL.
4. `scripts/zk_indexer_rpc_fetch.ts` supports two fetch modes (address mode and exact-signature mode via `--signature`) and two decoder modes (`event-json` and `anchor-event-parser`) via `--decoder`, `--idl`, and `--program-id` flags; in exact-signature mode `--address`, `--limit`, `--before`, and `--until` are rejected; `anchor-event-parser` mode wires `createAnchorEventParserLogDecoderFromIdl` into the fetch → decode → sort → snapshot pipeline; `--dry-run` builds the snapshot in memory without writing to disk; in normal write mode the written snapshot is immediately verified with `loadSnapshot` before success is reported.
5. `scripts/ops/submit_root_devnet.ts` — guarded operator bridge from local indexer snapshot to on-chain `allowed_roots`. Loads and verifies the snapshot (full Poseidon tree replay via `loadSnapshot`), then submits the root via `addAllowedRoot`. No-flag mode exits with a safety message; `--dry-run` validates the snapshot without RPC, transaction, or wallet; `--yes` performs read-only preflight checks (admin_authority, paused, root presence, capacity) and sends exactly one `addAllowedRoot` transaction with post-send verification. Root submission is not ZK proof verification; it only registers the root in the `allowed_roots` list that the withdrawal path checks. Until `withdraw_zk` (Phase 4) is implemented, root submission does not create privacy or trustless withdrawals.
6. `scripts/ops/inspect_allowed_roots_devnet.ts` — read-only operator inspection script for the on-chain `verifier_config` / `allowed_roots` state. Does not require a wallet. Does not send transactions. Does not submit roots. Decodes the `verifier_config` PDA using the known Borsh layout and prints admin authority, paused state, threshold, verifier count, allowed root list, capacity, and whether a supplied `--expected-root` is present. `--json` flag for machine-readable output. This is the recommended way to verify that a root is present in `allowed_roots` after submission. See `docs/DEVNET_ALPHA_RUNBOOK.md` §2.8.

**Positive devnet result (2026-06-02):**

The verified snapshot root from the positive NoteDeposited smoke (see `docs/DEVNET_ALPHA_RUNBOOK.md` §2.5 and §2.7) was submitted to `allowed_roots` on devnet via `addAllowedRoot`. Post-send verification confirmed the root is present in the on-chain registry.

- Transaction: `4YAoaTuRZGj9Sbi8Sz2PtgEM2TnRwZjdS8FkrVCtu2Ea938gg7Kc7kzggdKinmT64QMKhgNDfmRfyouhv48ZzQnH`
- Root: `2a065f5ccc90a22c2d5789d4ec9c65dc0189c18c43c785d3ac54fd00e93f8dd3`
- `post_send_verified: true`

`allowed_roots` gating is now exercised on devnet. This is root registration only — not proof verification. `withdraw_zk`, the on-chain Groth16 verifier, and production trust model hardening (`root_submitter` authority, finality depth policy) remain future work.

**Remaining work:**

- Finality depth policy — closed for the devnet alpha; see `docs/indexer_finality_policy.md` and §12.
- ~~Separate `root_submitter` authority~~ — implemented; see §12.
- ~~Guarded root-submitter rotation tooling~~ — implemented; `scripts/ops/set_root_submitter_devnet.ts` and `tests/ops_set_root_submitter_devnet.ts` (55 tests). See `docs/DEVNET_ALPHA_RUNBOOK.md` §2.9.
- WebSocket subscription / live ingestion.
- ~~Phase 4 prover-input / witness export~~ — implemented; see `docs/status/phase4/PHASE4_WITNESS_EXPORT.md`. Exports `witness.json` (private prover-input bundle, **does not persist the raw secret**) and `public.json` (public inputs) from a local snapshot. Does not generate or verify proofs.
- ~~`withdraw_zk` instruction and on-chain Groth16 verifier~~ — implemented; real Groth16 verifier wired and tested. See `docs/ZK_REAL_PROOF_CU_BENCHMARK.md`. Historical interface spec: `docs/status/phase4/PHASE4_WITHDRAW_ZK_INTERFACE.md`.

**Implementation order (once doc is accepted):**

1. `init_note_tree` instruction
2. `deposit_note` instruction
3. `deposit_note` tests (items listed in §11)
4. Off-chain indexer prototype
5. Root-submitter prototype
6. Root lifecycle integration tests
7. Phase 4: `withdraw_zk` on-chain verifier integration
