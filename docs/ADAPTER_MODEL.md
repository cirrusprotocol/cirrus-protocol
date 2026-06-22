# Cirrus Adapter Model

Status: M1 design note
Scope: devnet-alpha architecture
Reference adapter: `WITHDRAW_SOL_V1`

Cirrus is a metadata-aware ZK protocol for private settlement and claim adapters.

Cirrus currently has one working reference adapter: `WITHDRAW_SOL_V1`.

That adapter proves a fixed-denomination SOL note, checks an accepted Merkle root, consumes a nullifier, and binds the withdrawal to a settlement intent.

The next step is to make that pattern explicit.

This document defines the adapter model Cirrus will use for future private actions.

The core rule is:

```text
proof + root + global_nullifier + intent_hash = valid private action
```

For `WITHDRAW_SOL_V1`, the current `tx_hash` is the adapter-specific `intent_hash`.

## 1. Why adapters

Cirrus Core should stay small.

It should not become a separate protocol for every private action.

The core responsibilities are:

* verify the proof
* check the accepted root / root domain
* prevent nullifier replay
* bind the proof to an action intent
* fail closed when the action does not match the expected adapter rules

The adapter defines the meaning of the action.

A withdrawal adapter defines a withdrawal.

A claim adapter defines a claim.

A future payment-receipt adapter defines a receipt claim.

This keeps the core model stable while allowing new private actions to be added in a controlled way.

## 2. Adapter responsibilities

An adapter is not only an instruction name.

An adapter is a versioned contract between the circuit, the on-chain program, the client, and the privacy model.

Each adapter defines:

* `adapter_id`
* `note_family`
* `root_domain`
* public input order
* `intent_hash` schema
* nullifier policy
* event policy
* diagnostic requirements
* known limitations

The adapter should be understandable without reading the entire codebase.

A reviewer should be able to answer:

```text
What does this proof authorize?
Which tree/root does it use?
Which nullifier is consumed?
Which public action is bound by intent_hash?
Which metadata becomes public?
```

If those questions are unclear, the adapter model is incomplete.

## 3. Core terms

### `adapter_id`

A stable identifier for the action type.

Examples:

```text
WITHDRAW_SOL_V1
PRIVATE_CLAIM_V1
```

The `adapter_id` is bound at action time through `intent_hash`.

It should not be added to generic deposit commitments unless the note family explicitly requires early binding.

### `note_family`

The class of note the adapter can consume.

Examples:

```text
VALUE_NOTE_TREE_V1
CLAIM_NOTE_TREE_V1
```

A note family should describe the note type, not the final adapter.

For example, a value note can be used by withdrawal-style adapters. A claim note can be used by claim-style adapters.

### `root_domain`

The tree family a root belongs to.

Preferred examples:

```text
VALUE_NOTE_TREE_V1
CLAIM_NOTE_TREE_V1
```

Avoid adapter-specific root domains unless needed.

For example, `WITHDRAW_SOL_V1_ROOT` would split the anonymity set earlier than necessary.

### `global_nullifier`

A public anti-replay value derived from a private nullifier.

The default policy is:

```text
GLOBAL_NULLIFIER_V1
```

Meaning:

```text
one note = one private action
```

Scoped or multi-use nullifiers are not part of the default model.

In `WITHDRAW_SOL_V1`, the generic `global_nullifier` role is currently represented by `nullifier_hash`.

### `intent_hash`

A domain-separated hash that binds the proof to the exact public action.

For `WITHDRAW_SOL_V1`, this is currently called `tx_hash`.

Going forward, adapter docs should describe it as an `intent_hash`.

A good `intent_hash` should bind the fields that matter for correctness and replay resistance, such as:

* adapter id
* program or pool context
* recipient or action target
* relayer, if relayer-bound
* amount or bucket
* fee or fee bucket
* expiry or validity window
* chain id
* circuit version
* adapter-specific action hash

Not every adapter needs every field, but omitted fields should be intentional.

## 4. Public input model

Default public input order:

```text
[0] root
[1] global_nullifier
[2] intent_hash
```

Adapters should keep this order unless there is a strong reason to change it.

Changing the public input order requires a new adapter or circuit version.

Encoding rules:

* bind full Solana public keys
* avoid truncation
* use explicit endianness
* domain-separate hashes
* version hash schemas
* keep Rust and TypeScript parity vectors
* test public input order directly

The point is simple: a valid proof should not be reusable for a different public action.

## 5. Delayed adapter binding

Generic note creation should avoid binding to a final adapter too early.

Preferred flow:

```text
deposit / commitment phase:
  note_family
  note_version
  note_secret
  note_bucket

action phase:
  adapter_id
  root
  global_nullifier
  intent_hash
  proof
```

This lets the note belong to a broader tree family while the final action is bound later.

Default rule:

```text
adapter_id is not part of the generic note commitment.
adapter_id is part of the action-time intent_hash.
```

This avoids unnecessary tree fragmentation.

## 6. Minimal adapter manifest

Each adapter should have a small manifest.

Example:

```json
{
  "adapter_id": "WITHDRAW_SOL_V1",
  "status": "devnet-alpha-reference",
  "note_family": "VALUE_NOTE_TREE_V1",
  "root_domain": "VALUE_NOTE_TREE_V1",
  "nullifier_policy": "GLOBAL_NULLIFIER_V1",
  "public_inputs": [
    "root",
    "global_nullifier",
    "intent_hash"
  ],
  "intent_hash_schema": "WITHDRAW_SOL_INTENT_V1",
  "circuit": {
    "name": "withdraw_sol_v1",
    "version": 1,
    "proof_system": "groth16",
    "curve": "bn254"
  },
  "diagnostics_required": [
    "CANDIDATE_SET",
    "ROOT_FRESHNESS",
    "TIMING_LINKABILITY",
    "PARAMETER_FINGERPRINT",
    "RECIPIENT_RELAYER"
  ]
}
```

The manifest is a review target.

It should be small enough to read and strict enough to catch accidental adapter drift.

## 7. Event policy

Events are part of the privacy surface.

The default event policy is minimal public fields.

Events should avoid raw metadata unless the adapter explicitly requires it.

Avoid emitting:

* raw claim domain
* raw resource identifier
* raw issuer identifier
* raw user identifier
* raw invoice id
* raw memo
* note secret
* nullifier preimage
* unnecessary deposit-time adapter labels

Action-time adapter ids are acceptable when they are part of the public action.

Deposit-time adapter labels should be avoided for generic note families.

## 8. Diagnostics

Adapters should define the diagnostics needed to interpret their metadata risk.

Diagnostics are warnings, not proofs.

Default finding levels:

```text
CRITICAL
HIGH
ELEVATED
OBSERVED
UNKNOWN
```

Required diagnostics depend on the adapter, but most adapters should consider:

* candidate set size
* root freshness
* timing linkability
* amount or bucket uniqueness
* fee or expiry fingerprint
* recipient reuse
* relayer reuse
* event metadata
* snapshot/indexer hygiene

Diagnostic output should be conservative.

If required data is missing, return `UNKNOWN`, not a positive privacy claim.

## 9. Adapter review checklist

Before an adapter is accepted for controlled devnet-alpha testing, it should answer:

```text
Action:
- What private action does this authorize?
- Is it value-bearing or claim-only?

Proof:
- What are the private inputs?
- What are the public inputs?
- What is the public input order?

Intent:
- What fields are bound by intent_hash?
- Is adapter_id included?
- Is the action target included?
- Are fee/expiry/version fields handled?

Nullifier:
- Is the nullifier global?
- What prevents replay?

Root:
- Which root_domain is accepted?
- How is root provenance checked?

Metadata:
- Which fields become public?
- Which diagnostics are required?

Events:
- What events are emitted?
- Do they reveal avoidable raw metadata?
```

This checklist is intentionally short.

Detailed threat modeling can live in adapter-specific docs.

## 10. Reference adapter: WITHDRAW_SOL_V1

`WITHDRAW_SOL_V1` is the first Cirrus reference adapter.

It proves ownership of a fixed-denomination SOL note and withdraws to a recipient.

Current formula:

```text
proof + root + nullifier_hash + tx_hash = valid withdrawal
```

Generic adapter mapping:

```text
nullifier_hash = global_nullifier
tx_hash = intent_hash
```

Public inputs:

```text
root
nullifier_hash
tx_hash
```

The adapter binds settlement through `tx_hash`.

Conceptually, the intent includes:

```text
program context
pool/config context
recipient
relayer
denomination
fee
chain id
expiry slot
circuit version
```

The important design decision is that the proof is not only bound to a root and nullifier.

It is bound to a concrete settlement intent.

Known scope:

* devnet-alpha reference adapter
* fixed SOL denomination
* real Groth16 path
* root checking
* nullifier replay protection
* tx_hash-bound settlement
* not a generic adapter framework by itself

`WITHDRAW_SOL_V1` is the reference point for future adapters, not the final product shape of Cirrus.

## 11. Planned adapter: PRIVATE_CLAIM_V1

`PRIVATE_CLAIM_V1` is the next adapter target.

Its purpose is to show that Cirrus is not limited to withdrawals.

A claim adapter should prove that a private claim exists or is authorized without exposing raw claim metadata.

Expected shape:

```text
proof + root + global_nullifier + intent_hash = valid private claim
```

Possible note family:

```text
CLAIM_NOTE_TREE_V1
```

Possible root domain:

```text
CLAIM_NOTE_TREE_V1
```

Expected policy:

* generic claim commitment
* adapter id bound at action time
* global nullifier
* minimal event surface
* no raw claim domain in the default event
* no raw issuer/resource/user fields in the default event
* diagnostics before making any public privacy-related claims

A minimal action event may look like:

```text
PrivateClaimVerified {
  adapter_id,
  root,
  global_nullifier
}
```

The claim-specific data should be hashed or kept local unless the adapter explicitly requires disclosure.

`PRIVATE_CLAIM_V1` should be built before more specific adapters such as x402 receipt claims.

## 12. Versioning

Adapter semantics should not change silently.

Version when changing:

* public input order
* intent hash schema
* note family
* root domain
* nullifier policy
* circuit
* verifier key
* event schema

Examples:

```text
WITHDRAW_SOL_V1
WITHDRAW_SOL_V2
PRIVATE_CLAIM_V1
PRIVATE_CLAIM_V2
```

A new version is better than silently changing the meaning of an existing adapter id.

## 13. Summary

The adapter model is the bridge between the current reference withdrawal flow and future Cirrus private actions.

The model keeps the core rule stable:

```text
proof + root + global_nullifier + intent_hash = valid private action
```

`WITHDRAW_SOL_V1` proves the first action.

`PRIVATE_CLAIM_V1` should prove the model generalizes.

The long-term value of Cirrus is not only that it can verify a ZK proof.

The value is that private actions can be added with explicit intent binding, nullifier discipline, root-domain discipline, and metadata diagnostics.

## Appendix A: Future topics

The following topics are intentionally not part of the core M1 adapter model.

They should be handled in separate design notes when needed.

### Hidden exit commitment

A future withdrawal adapter may hide the recipient at deposit time by committing to an exit target.

At withdrawal time, the recipient becomes public and the circuit proves it matches the earlier hidden commitment.

This delays recipient disclosure.

It does not hide the recipient forever and does not solve timing, relayer, or RPC metadata.

### Adapter registry

A future registry may track adapter ids, manifest hashes, verifier routes, circuit versions, and adapter status.

The registry should not imply production readiness.

It should only make adapter state explicit.

### CLAIM_X402_V1

x402-style receipt or payment claims may become a future adapter family.

This should come after `PRIVATE_CLAIM_V1`.

x402 requests can expose HTTP, resource, facilitator, and timing metadata, so the adapter should be diagnostic-first.

### Scoped nullifiers

Scoped nullifiers may be useful for future non-value credential systems.

They are not part of the default model.

The default model remains `GLOBAL_NULLIFIER_V1`.
