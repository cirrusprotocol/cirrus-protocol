# Diagnostic Layer Scope

> Devnet-alpha only. Unaudited. These tools are support infrastructure for the `withdraw_zk`
> operator/tester flow. They are not the product, not an audit, and not a privacy guarantee.

---

## What the diagnostic layer is

- Support tooling for the single-operator `withdraw_zk` devnet-alpha flow.
- Read-only (RPC or local file) — no signing, no keypairs, no transactions, no mutation.
- Local-first where possible (`analyze_snapshot_hygiene.ts` makes no RPC calls).
- Conservative: warnings describe observable public state or observable local state only.
- Manual operator guardrails, not automation.
- Deterministic: given the same on-chain or local state, the same report is produced.

## What the diagnostic layer is not

- Not the core product. The product is the real-proof `withdraw_zk` path.
- Not a privacy score or anonymity-set estimator.
- Not an audit.
- Not automated monitoring or alerting.
- Not a WebSocket subscriber or live event follower.
- Not telemetry collection.
- Not a claim layer or settlement layer.

## Current inventory

| Tool | Category | Observes | Does not observe |
|---|---|---|---|
| `devnet_doctor.ts` | Pre-session summary | Program deployment, pool PDA, config PDA, root capacity, chain config, note tree state, leaf count | Private witnesses, note secrets, proof validity |
| `analyze_allowed_roots_hygiene.ts` | Config/root hygiene | Verifier config, allowed roots, authority concentration | Pending private intent, root correctness beyond public state |
| `analyze_snapshot_hygiene.ts` | Local snapshot hygiene | Snapshot leaf count, selected leaf position, denomination bucket | Live chain state, secrets |
| `inspect_allowed_roots_devnet.ts` | Read-only root inspection | Allowed roots and config PDA contents | Whether a pending proof should use a given root |
| `inspect_nullifier_state_devnet.ts` | Read-only nullifier inspection | Nullifier marker PDA existence and metadata | Whether a future send is guaranteed to succeed |
| `verify_withdraw_zk_send_devnet.ts` | Post-send verification | Signature status, nullifier marker, pool/recipient/relayer balances | Audit status, future replay safety |

`remove_allowed_root_devnet.ts` is a **guarded mutation tool** — it sends an on-chain transaction
and requires explicit `--yes` confirmation. It is not a diagnostic.

## Warning model

Warning codes (e.g. `[NULLIFIER_MARKER_EXISTS]`, `[SMALL_SNAPSHOT_LEAF_COUNT]`,
`[NEAR_CAPACITY]`) are conservative operational signals.

- A warning describes a specific observable condition, not a security verdict.
- A warning is not a privacy verdict. A clean report is not a privacy guarantee.
- Warnings are non-blocking: scripts exit 0 when the report is generated, even when warnings are
  present. Scripts exit 1 only for parse errors, RPC read failures, or missing required inputs.
- Operator judgment is always required before proceeding to a live send.

## Operator action model

- Run diagnostics before test sessions as a pre-session checklist.
- Run simulation (`withdraw_zk_devnet.ts --simulate`) before any live send.
- Run post-send verification (`verify_withdraw_zk_send_devnet.ts`) after a live send.
- Use mutation tools (`remove_allowed_root_devnet.ts`, `submit_root_devnet.ts`, etc.) only after
  read-only diagnostics and explicit operator approval.
- Diagnostic output does not replace simulation, and simulation does not replace operator judgment.

## Relationship to `withdraw_zk`

The core product is the real-proof `withdraw_zk` path: Groth16/BN254 proof generation, on-chain
verification, nullifier consumption, and fund settlement. Diagnostics support this path by
checking observable preconditions (root present, config healthy, snapshot leaf count) and
postconditions (nullifier marked, balances changed, signature confirmed). They do not participate
in the proof pipeline and do not claim to validate proof correctness.

Diagnostics must not become the product narrative.

## Future additions boundary

A new diagnostic belongs in this layer only if it:

- is read-only or local-only (no signing, no keypairs, no transactions),
- answers one specific operator or tester question in the `withdraw_zk` flow,
- has mocked/injected tests that do not require live RPC,
- avoids keypair loading and transaction sending,
- avoids privacy, audit, or production-readiness claims, and
- does not aggregate results into a score.

A future idea does **not** belong in this layer if it requires:

- autonomous or periodic monitoring,
- WebSocket live event subscription,
- cross-session data aggregation,
- adaptive behavior,
- privacy scoring,
- claim or settlement semantics.

See `docs/KNOWN_LIMITATIONS.md` for documented operational limits and
`docs/DEVNET_ALPHA_RUNBOOK.md` for the full operator procedure.
