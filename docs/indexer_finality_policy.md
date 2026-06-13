# Indexer Finality Policy

> **Scope:** This document defines the commitment-level and finality policy for
> the off-chain indexer and root submission workflow. It closes the open decision
> recorded in `docs/ZK_DEPOSIT_AND_INDEXER_SPEC.md` for reorg finality depth.

---

## 1. Commitment Level Semantics

Solana exposes three commitment levels for account reads and transaction fetches.
Each level reflects a different point in the cluster's consensus process:

**`processed`**

The node has applied the transaction locally and the state reflects the most
recently processed block. This block may not have been voted on by any other
validator. It is the least durable level: any validator — including the one you
are querying — may see a different processed state. A root built from events
fetched at `processed` may reflect commitments that are on a fork and will
never be canonical.

**`confirmed`**

The block has been voted on by a supermajority of stake-weighted validators.
It is very unlikely to be rolled back, but rollback is not impossible in all
circumstances. For a single-operator devnet alpha where the operator controls all keys and
no real value is at risk, `confirmed` provides adequate safety for root
submission.

**`finalized`**

The block has reached the strongest confirmation state recognized by the
cluster — maximum lockout. Treat `finalized` as the required commitment for
any root that may gate withdrawals with real value.

The number of slots or wall-clock seconds it takes to reach each level is
cluster-dependent and varies with network conditions. Do not rely on any
fixed slot count or time estimate as an operational invariant. The commitment
level itself is the durable semantic — not the elapsed time.

---

## 2. Operational Decision for This Deployment

| Deployment context                                          | Minimum commitment for root submission   |
| ----------------------------------------------------------- | ---------------------------------------- |
| Private devnet alpha (no real value)                        | `confirmed`                              |
| Any deployment where roots gate withdrawals with real value | `finalized`                              |
| `processed`                                                 | Never use for operator root registration |

`processed` must not be used for root submission in any context where the root
may later gate withdrawals. For private/local debugging, `processed` may only
be used for non-authoritative inspection, never for operator root registration.

`confirmed` is the default for the current devnet alpha and is acceptable for
its scope: single-operator, no real value, private controlled deployment.

`finalized` is required before any deployment where submitted roots will gate
withdrawals by parties other than the protocol operator, or where the pool
holds real value.

---

## 3. Snapshot Provenance Metadata

Version 2 snapshots produced by `scripts/zk_indexer_rpc_fetch.ts` include a
`meta` block that records fetch provenance. The `meta` block carries the
following optional fields:

| Field              | Description                                                                    |
| ------------------ | ------------------------------------------------------------------------------ |
| `fetch_commitment` | The `--commitment` value in effect when events were fetched (e.g. `confirmed`) |
| `source_mode`      | `"address"` (default) or `"exact-signature"` (`--signature` mode)              |
| `rpc_url`          | The RPC endpoint used, with query-string stripped to avoid leaking API keys    |
| `program_id`       | The program ID filter used when decoding events (anchor-event-parser mode)     |
| `address`          | The account/program address queried (address mode only)                        |
| `signature`        | The transaction signature fetched (exact-signature mode only)                  |
| `created_at`       | ISO 8601 wall-clock time at which the snapshot was built                       |

**RPC URL redaction note:** Query-string parameters are stripped from `rpc_url`
before storage to avoid leaking API keys embedded in query strings (e.g.
`?api-key=…`). Path-embedded API keys (e.g. Alchemy-style
`/v2/YOUR_API_KEY` URLs) are not stripped; operators using path-based keys
should use a local proxy or a public endpoint when the snapshot file may be
shared.

**Version 1 snapshots:** Snapshots produced before this schema change are
version 1 and have no `meta` field. For those snapshots, the original operator
responsibility applies: preserve the exact fetch command and its output
externally so that the commitment level can be audited later.

**Root submission tooling:** `submit_root_devnet.ts` accepts both version 1 and
version 2 snapshots. The `--commitment` flag on `submit_root_devnet.ts` governs
the RPC calls made during the submission preflight (e.g., reading the config
PDA); it is independent of the commitment level recorded in the snapshot's `meta`
block. The existing warning emitted when `--commitment processed` is selected
reflects the commitment level of the submission run itself, not necessarily the
snapshot's fetch metadata.

---

## 4. Reorg Risk and Recovery

A Merkle root submitted to `allowed_roots` is not automatically removed if the
underlying deposit events are later determined to be on a forked block. The
`allowed_roots` list is managed by `root_submitter_authority`: only
`addAllowedRoot` and `removeAllowedRoot` (gated by `root_submitter_authority`)
modify it. The admin can rotate `root_submitter_authority` via
`setRootSubmitterAuthority`; at initialization and after migration it defaults
to `admin_authority`.

If a root is discovered to correspond to a reorged or forked event sequence:

1. Call `removeAllowedRoot` with the affected root bytes to remove it from the
   on-chain registry.
2. Re-fetch events at `finalized` commitment from the canonical chain.
3. Rebuild the snapshot and recompute the correct root.
4. Submit the corrected root via `addAllowedRoot`.

The intended withdrawal path is expected to reject roots that are not in
`allowed_roots`. Removing a forked root prevents any withdrawal path that
checks `allowed_roots` from accepting an intent based on that root.

See `docs/RECOVERY_PROCEDURES.md` for general recovery procedures.

---

## 5. Capacity Approach Alert

`allowed_roots` has a maximum capacity of `MAX_ROOTS = 10`. The
`submit_root_devnet.ts` script emits a `[WARN]` when the list reaches
`MAX_ROOTS - 2` (8 entries) and throws an error when the list is full (10
entries). This implements the alert specified in
`docs/ZK_DEPOSIT_AND_INDEXER_SPEC.md`: "alert when list reaches capacity − 2."

Until `withdraw_zk` exists, removal policy is operational only — stale or
superseded roots can be removed at operator discretion. Once withdrawals exist,
root retention and removal must account for pending proofs and withdrawal windows:
under the intended withdrawal design, removing a root that a prover has committed
to can cause that withdrawal to fail with `UnknownMerkleRoot`.

---

## 6. Decision Record

| Field                 | Value                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Open decision         | Reorg finality depth for indexer (see `docs/ZK_DEPOSIT_AND_INDEXER_SPEC.md`)                                                    |
| Status                | **Closed**                                                                                                                      |
| Decision              | `confirmed` for the devnet alpha; `finalized` for any deployment with real value; `processed` never for operator root registration |
| Rationale             | Commitment level semantics, not slot counts, are the stable invariant                                                           |
| Snapshot metadata gap | Closed — version 2 snapshot schema records fetch provenance in `meta` block                                                     |
| Date                  | 2026-06-02                                                                                                                      |
