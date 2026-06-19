# Metadata Linkability in Cirrus ZK Settlement Flows

## Status

Research note.

This document does not define a complete solution, a privacy proof, or a finished
mitigation strategy. It is a problem statement for the metadata surfaces that
remain visible around Cirrus ZK settlement and claim flows.

Cirrus is a devnet-alpha research prototype. It is unaudited, not mainnet-ready,
not intended for real funds, and makes no privacy guarantee.

## Motivation

A zero-knowledge proof can hide a private witness. It does not automatically
hide the public context around the proof.

In a shielded withdrawal or private claim system, the proof may be valid, the
nullifier may prevent replay, and the Merkle root may be accepted by the
program. An observer may still be able to narrow the likely source commitment
by combining public metadata from the transaction, root history, events,
relayer behavior, timing, and infrastructure usage.

This document treats metadata linkability as a first-class protocol concern. It
is intentionally conservative: it identifies public surfaces that need review
before Cirrus grows beyond its first devnet-alpha flow.

## Demo Observation

The devnet-alpha demo made one limitation clear: a valid proof path does not
imply practical privacy.

In small test sets, a fresh root, recent deposit, visible withdrawal, and narrow
time window can make the likely source commitment easy to guess. This is not a
verifier failure. It is a metadata and anonymity-set problem.

The current `WITHDRAW_SOL_V1` path demonstrates root provenance, nullifier
replay protection, and tx_hash-bound settlement on devnet. It does not remove
the need to reason about the public metadata around that path.

## Core Privacy Question

For every ZK action, the question is not only whether the proof is valid. The
protocol also needs to ask:

```text
Which public fields help an observer narrow the path from a later action back to an earlier commitment?
```

If a public field helps narrow that path, it is part of the metadata linkability
surface.

## Practical Model: Effective Anonymity Set

A useful practical model is to treat each public field as a filter on the
possible source set. The effective anonymity set is narrowed by intersections
of observable properties:

```text
effective anonymity set =
  root set
∩ amount bucket
∩ adapter/action type
∩ time window
∩ relayer set
∩ recipient behavior
∩ fee/expiry pattern
∩ infrastructure metadata
```

This is not a formal privacy proof. It is a working model for protocol review.
A field can be cryptographically safe and still be operationally linkable when
combined with other public fields.

## Metadata Surfaces

### 1. On-Chain Action Metadata

Instruction names, account lists, and events are visible to chain observers and
indexers. They are useful for execution, debugging, and provenance, but they
also describe the shape of the action.

Instruction names such as `deposit_note`, `withdraw_zk`, or a future claim
instruction reveal the action type. Public accounts can reveal the pool, config,
recipient, relayer, nullifier marker, verifier-related accounts, or future
claim state accounts. Event fields can reveal roots, nullifiers, intent hashes,
adapter identity, claim-domain hints, recipients, relayers, fees, or other
semantic context.

The main issue is not that these fields exist. Some of them are necessary for a
public chain. The issue is that a mechanical or overly verbose action surface
can make actions easier to cluster. A future adapter should therefore review
which fields are necessary for execution and which fields are only convenient
for indexing or debugging.

Events deserve particular care. A minimal event can support indexers and root
provenance. A semantic event can disclose the very domain information that the
ZK proof avoided revealing.

### 2. Tree, Root, and Snapshot Metadata

A Merkle root proves membership in a set, but it also carries context. The root
may imply which tree, asset family, claim family, epoch, snapshot, or
operator-submitted root was used. If roots are scoped too narrowly, they can
split the anonymity set even when the proof itself remains valid.

Root freshness is also a linkability surface. In a small devnet-alpha set, the
pattern of one recent deposit, one newly submitted root, and one visible
withdrawal shortly after can make the likely source commitment obvious. This is
not a failure of root verification. It is a practical anonymity-set limitation.

Snapshot and indexer data are part of the same surface. Slot ranges, event
counts, leaf counts, root values, RPC sources, and snapshot provenance help make
roots reproducible. At the same time, published snapshot metadata must avoid
private note material, local paths, operator-only context, or anything that
turns root provenance into an operational leak.

The open design issue is how to preserve root provenance without over-scoping
roots into small, easily classified sets.

### 3. Action Parameter Metadata

The current `WITHDRAW_SOL_V1` flow uses `tx_hash` as the adapter-specific intent
binding for settlement. More generally, Cirrus should reason about an intent
hash: a digest of the public action parameters that a proof is meant to bind.

Intent binding is necessary for safety. Without it, a valid proof could be
reused against unintended settlement parameters. The linkability question is
which parameters must be bound, which parameters must be public, and which
parameters become fingerprints when they are too specific.

For the current withdrawal flow, the action parameters include recipient,
relayer, denomination, fee, expiry, chain context, and circuit version. Future
claim-style adapters may include adapter identity, claim action, payment or
resource context, and other domain-specific fields.

Amounts and denominations are particularly strong filters. A fixed denomination
can group users, but each denomination bucket is its own anonymity set. Unique
or unusual amounts can act as fingerprints.

Fees can have the same effect. A user-specific or relayer-specific fee pattern
may help distinguish one action from another. Expiry values can also become
fingerprints when every proof uses a unique slot or unusually narrow validity
window.

This document does not prescribe a final parameter policy. It records that
amount, fee, expiry, and intent-hash contents are part of the metadata
linkability surface.

### 4. Timing and User Behavior

Timing is one of the strongest practical linkability surfaces.

A short delay between deposit and withdrawal, claim commitment and claim,
payment receipt and redemption, or root submission and action can narrow the
candidate set. This is especially visible in small test sets, where the number
of plausible commitments is low.

User behavior can further reduce privacy. Reusing wallets, recipients, relayers,
amount patterns, or publicly sharing transaction hashes can provide external
links that the proof system itself does not see. Demo behavior can also leak
context if it reveals the order of operations, local files, operator actions,
or a small set of test transactions.

The important distinction is that timing and user behavior are not verifier
failures. They are part of the practical privacy model. A valid proof only says
that the private statement is satisfied. It does not say that the surrounding
usage pattern is unlinkable.

### 5. Relayer and Infrastructure Metadata

Relayers can reduce direct wallet linkage, but they can also become metadata
concentration points. Relayer reuse, single-relayer dominance, fee patterns,
recipient/relayer aliasing, and relayer-side request logs can all add context
outside the proof.

RPC and infrastructure metadata are not necessarily visible on-chain, but they
are still part of the privacy surface. RPC providers, hosted APIs, facilitators,
relayers, and indexers may observe request timing, simulations, snapshot
fetches, proof-generation requests, transaction submission behavior, and other
network-level signals.

This document does not assume that Cirrus can solve infrastructure privacy at
the protocol layer. It records that infrastructure metadata is a separate layer
from on-chain metadata and should not be confused with a verifier guarantee.

### 6. Adapter and Claim-Domain Metadata

Adapter identity is metadata. In an adapter-based system, names such as
`WITHDRAW_SOL_V1`, `PRIVATE_CLAIM_V1`, `CLAIM_X402_V1`, `WITHDRAW_SPL_V1`, and
`CROSS_CHAIN_CLAIM_V1` describe different action families. If adapter identity
is visible too early, it can split the anonymity set before the action happens.

Claim-domain metadata is similar. A claim domain, issuer, API endpoint, payment
receipt, access right, resource family, or external payment context can narrow
the set of plausible users even if the proof hides the witness.

External payment systems add another boundary. Resource URLs, payment amounts,
payment recipients, request headers, facilitators, chain identifiers, agent
identity, and server logs may all exist before the private claim is even formed.
For any future payment-related adapter, that upstream metadata must be treated
as part of the public/private boundary, not as an implementation detail outside
the privacy model.

The open design issue is when adapter identity and domain context become public,
and how much of that context is required for safety versus convenience.

## Working Principle for New Adapters

Before adding a new adapter, review it against two questions:

1. What new metadata does this adapter reveal?
2. Does this metadata reduce the effective anonymity set?

The review should include on-chain fields, events, roots, nullifiers, intent
hash contents, timing, recipient or target behavior, relayer assumptions,
infrastructure metadata, and public/private boundary effects.

This review is not a replacement for testing or auditing. It is a design gate to
avoid adding new action types faster than their metadata surface is understood.

## Current WITHDRAW_SOL_V1 Linkability Notes

The current `WITHDRAW_SOL_V1` devnet-alpha flow should be read with the
following visible surfaces in mind:

- the withdrawal instruction is public
- the accepted Merkle root is public
- the nullifier hash is public
- the recipient and relayer are public
- the denomination, fee, expiry, and circuit version are part of the settlement
  context
- root freshness and small test-set size can make source commitments easier to
  guess
- snapshots and indexer outputs support provenance, but must not publish private
  note material or operator-local context

These are expected properties of the current devnet-alpha flow. They do not
mean the verifier path is incorrect. They define the metadata surface that
future diagnostics and adapter reviews need to account for.

## Current Scope

The current implemented adapter is `WITHDRAW_SOL_V1`.

Future adapter names such as `PRIVATE_CLAIM_V1`, `CLAIM_X402_V1`,
`WITHDRAW_SPL_V1`, and `CROSS_CHAIN_CLAIM_V1` are examples of possible future
action families. They are not commitments, launch promises, or a finalized
roadmap.

Each future adapter must be reviewed against this metadata model before
implementation.

## Summary

The main privacy challenge is not only proving that a note or claim is valid.
The main challenge is preventing the surrounding public context from making the
source commitment easy to infer.

Cirrus currently demonstrates a devnet-alpha ZK withdrawal path with root
provenance, nullifier replay protection, and tx_hash-bound settlement. That path
is still surrounded by metadata: roots, timing, accounts, events, recipients,
relayers, fees, expiry values, adapter identity, snapshots, and infrastructure
behavior.

Metadata linkability should therefore be treated as part of the protocol model,
not as an afterthought.
