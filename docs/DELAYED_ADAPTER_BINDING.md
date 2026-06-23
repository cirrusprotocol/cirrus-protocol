# Delayed Adapter Binding

Status: M1.5 design note
Scope: devnet-alpha architecture
Depends on: `docs/ADAPTER_MODEL.md`

Cirrus uses adapters to define private actions.

This document defines when an adapter is bound to a note.

The design decision is:

```text
Deposits should bind to a note family.
Actions should bind to an adapter.
```

In other words:

```text
deposit-time: note_family + root_domain
action-time: adapter_id + intent_hash
```

This keeps generic notes from being tied to a final action too early.

## 1. Summary

The default Cirrus model is delayed adapter binding.

A note commitment should not usually include `adapter_id`.

The adapter is bound later, when the private action is executed, through `intent_hash`.

By default:

```text
adapter_id MUST NOT be included in a generic note commitment.
adapter_id MUST be included in the action-time intent_hash.
```

This rule applies to new adapter families after `WITHDRAW_SOL_V1`.

Existing reference-adapter names may remain in older docs or code paths, but new adapter design should use the generic terms from `ADAPTER_MODEL.md`.

Delayed binding is not delayed authorization.

The adapter must still be fully bound before the action is executed.

## 2. Why this matters

Binding an adapter too early splits the anonymity set.

If deposits are adapter-specific, the tree can reveal future intent before the action happens.

Bad model:

```text
WITHDRAW_SOL_V1_TREE
PRIVATE_CLAIM_V1_TREE
CLAIM_X402_V1_TREE
```

Better model:

```text
VALUE_NOTE_TREE_V1
CLAIM_NOTE_TREE_V1
```

The first model tells observers more at deposit time.

The second model keeps deposits grouped by note type and delays the final action label until action time.

Delayed adapter binding does not remove all metadata.

It only avoids one avoidable source of metadata fragmentation.

Timing, amount buckets, relayers, recipients, events, and RPC behavior can still leak information.

## 3. Binding layers

Cirrus separates binding into three layers.

### 3.1 Note-family binding

This happens at deposit or commitment time.

It defines what kind of note exists.

Examples:

```text
VALUE_NOTE_TREE_V1
CLAIM_NOTE_TREE_V1
```

This binding is allowed early because different note families may require different circuits, witness shapes, or root domains.

### 3.2 Root-domain binding

This also happens early.

A root belongs to a tree family.

Examples:

```text
VALUE_NOTE_TREE_V1
CLAIM_NOTE_TREE_V1
```

The root domain should describe the tree family, not the final adapter.

Avoid:

```text
WITHDRAW_SOL_V1_ROOT
CLAIM_X402_V1_ROOT
```

unless the adapter truly requires a separate tree.

### 3.3 Adapter binding

This happens at action time.

The adapter defines what the note is being used for.

Examples:

```text
WITHDRAW_SOL_V1
PRIVATE_CLAIM_V1
```

The adapter is bound by `intent_hash`.

The generic action formula remains:

```text
proof + root + global_nullifier + intent_hash = valid private action
```

## 4. Deposit-time commitment

A generic note commitment should bind the note to its family and version, not to its final action.

A simplified value-note commitment may look like:

```text
note_commitment = H(
  NOTE_COMMITMENT_DOMAIN,
  note_family,
  note_version,
  note_secret,
  note_bucket,
  nullifier_commitment_or_secret_material
)
```

A simplified claim-note commitment may look like:

```text
claim_commitment = H(
  CLAIM_COMMITMENT_DOMAIN,
  note_family,
  note_version,
  claim_secret,
  claim_bucket,
  claim_nullifier_material
)
```

The exact hash schema is adapter-family-specific and must be versioned.

The important rule is that the generic commitment should not say:

```text
this note is definitely for WITHDRAW_SOL_V1
```

or:

```text
this note is definitely for CLAIM_X402_V1
```

unless the design intentionally accepts that metadata split.

## 5. Action-time intent hash

At action time, the adapter id is bound into the action context through `intent_hash`.

Depending on the instruction and event design, the adapter may also be directly visible to observers.

A simplified action intent may look like:

```text
intent_hash = H(
  INTENT_DOMAIN,
  adapter_id,
  adapter_version,
  root_domain,
  note_family,
  program_context,
  action_target,
  relayer_context,
  amount_or_bucket,
  fee_or_fee_bucket,
  expiry_or_epoch,
  circuit_version,
  adapter_specific_action_hash
)
```

Not every adapter needs every field.

But `adapter_id` is required.

The adapter id is part of what prevents the same proof from being interpreted as a different action.

## 6. What can be early-bound

Some fields are allowed to be early-bound.

### Allowed early bindings

* `note_family`
* `note_version`
* `root_domain`
* amount bucket or denomination, if the note family requires it
* claim bucket, if the claim family requires it
* commitment domain separator
* tree version

These fields define the shape of the note or tree.

They do not necessarily reveal the final adapter action.

### Usually not early-bound

* `adapter_id`
* final recipient
* relayer
* exact settlement action
* raw claim domain
* raw resource identifier
* raw issuer identifier
* raw x402 request data
* raw invoice or receipt id
* action-specific memo

Those fields should be action-time fields unless the adapter explicitly documents why they must be committed earlier.

## 7. Adapter compatibility

Delayed binding requires an adapter compatibility rule.

An adapter must define which notes it can consume.

Example shape:

```text
adapter_accepts(
  note_family,
  root_domain,
  note_version,
  bucket,
  nullifier_policy,
  circuit_version
) -> bool
```

Example:

```text
WITHDRAW_SOL_V1 accepts:
- note_family: VALUE_NOTE_TREE_V1
- root_domain: VALUE_NOTE_TREE_V1
- bucket: fixed SOL denomination
- nullifier_policy: GLOBAL_NULLIFIER_V1
- circuit_version: withdraw_sol_v1
```

Example:

```text
PRIVATE_CLAIM_V1 accepts:
- note_family: CLAIM_NOTE_TREE_V1
- root_domain: CLAIM_NOTE_TREE_V1
- bucket: claim-family-defined
- nullifier_policy: GLOBAL_NULLIFIER_V1
- circuit_version: private_claim_v1
```

Compatibility should be documented before implementation.

If compatibility is unclear, the adapter should not be accepted for controlled devnet-alpha testing.

## 8. Nullifier behavior

Delayed adapter binding does not mean delayed replay protection.

The default remains:

```text
GLOBAL_NULLIFIER_V1
```

Meaning:

```text
one note = one private action
```

A note can be generic before action time, but once it is consumed, the global nullifier is spent.

This prevents accidental cross-adapter double use.

Bad outcome to avoid:

```text
same note spent once by WITHDRAW_SOL_V1
same note spent again by PRIVATE_CLAIM_V1
```

A generic note may be compatible with more than one adapter before it is consumed, but the nullifier policy decides how many actions it can authorize.

For value-bearing notes, the answer should be one.

## 9. WITHDRAW_SOL_V1 mapping

`WITHDRAW_SOL_V1` is the current reference adapter.

Its current formula is:

```text
proof + root + nullifier_hash + tx_hash = valid withdrawal
```

Generic mapping:

```text
nullifier_hash = global_nullifier
tx_hash = intent_hash
```

`WITHDRAW_SOL_V1` binds the withdrawal through `tx_hash`.

Conceptually, `tx_hash` is the adapter-specific intent hash.

It binds the proof to the withdrawal settlement context.

The M1.5 rule does not require renaming working code.

It defines the terms future adapters should use.

## 10. PRIVATE_CLAIM_V1 implications

`PRIVATE_CLAIM_V1` should be designed with delayed adapter binding from the start.

A generic claim commitment should not expose:

* `PRIVATE_CLAIM_V1`
* `CLAIM_X402_V1`
* raw claim domain
* raw issuer
* raw resource
* raw user identifier
* raw payment request

The claim note should belong to a claim note family.

Example:

```text
note_family = CLAIM_NOTE_TREE_V1
root_domain = CLAIM_NOTE_TREE_V1
```

The action-time intent should bind the actual adapter.

Example:

```text
intent_hash = H(
  PRIVATE_CLAIM_INTENT_V1,
  adapter_id,
  root_domain,
  claim_action_hash,
  verifier_context,
  expiry_or_epoch,
  circuit_version
)
```

This lets Cirrus prove a claim without making the deposit or commitment phase unnecessarily adapter-specific.

## 11. Privacy effect

Delayed adapter binding improves one part of the metadata surface.

It reduces deposit-time action leakage.

It does not remove action-time leakage.

At action time, observers may still see:

* adapter id
* root
* nullifier hash
* recipient or action target, if public
* relayer
* fee
* expiry
* timing
* event fields

The goal is not to hide everything.

The goal is to avoid revealing final action intent before it is necessary.

A good adapter should make this distinction clear:

```text
deposit-time metadata
action-time metadata
infrastructure metadata
```

Each has a different privacy impact.

## 12. Good and bad patterns

### Good: generic value tree

```text
Deposit:
  note_family = VALUE_NOTE_TREE_V1
  root_domain = VALUE_NOTE_TREE_V1
  commitment = generic value note

Action:
  adapter_id = WITHDRAW_SOL_V1
  intent_hash = withdraw settlement hash
```

Why it is good:

* deposit does not expose the final adapter label
* value notes can be reviewed as a family
* action intent is still explicitly bound

### Bad: adapter-specific deposit tree

```text
Deposit:
  root_domain = WITHDRAW_SOL_V1_ROOT
  commitment = withdraw-specific note

Action:
  adapter_id = WITHDRAW_SOL_V1
```

Why it is bad:

* action type is leaked at deposit time
* future adapters cannot share the same note family
* anonymity set is fragmented early

### Good: generic claim family

```text
Deposit:
  note_family = CLAIM_NOTE_TREE_V1
  commitment = generic claim note

Action:
  adapter_id = PRIVATE_CLAIM_V1
  intent_hash = private claim action hash
```

Why it is good:

* raw claim type is not exposed at commitment time
* future claim adapters can reuse the claim-family model
* action metadata is delayed until verification

### Bad: raw claim metadata in commitment

```text
Deposit:
  commitment includes claim_domain = "api.example.com"
  commitment includes issuer = "merchant-id"
  commitment includes adapter_id = CLAIM_X402_V1
```

Why it is bad:

* claim domain partitions the set
* issuer partitions the set
* adapter id partitions the set
* x402-specific metadata leaks too early

## 13. Implementation requirements

New adapters should follow these requirements.

### Required

* define `adapter_id`
* define `note_family`
* define `root_domain`
* define `intent_hash` schema
* include `adapter_id` in `intent_hash`
* define public input order
* define nullifier policy
* document early-bound fields
* document action-time fields
* document metadata surfaces
* document diagnostic requirements
* provide Rust/TypeScript parity vectors for hashes
* provide negative tests for wrong adapter or wrong intent

### Not allowed by default

* adapter-specific root domains
* adapter id inside generic commitments
* raw claim metadata in generic commitments
* unversioned intent hashes
* truncated public key binding
* silent changes to public input order
* scoped nullifiers without separate design review

### Exceptions

Exceptions are allowed only if the adapter document explains:

* why early binding is required
* what metadata is revealed
* how the anonymity set is affected
* which diagnostics are required
* why a generic note family is insufficient

## 14. Test requirements

Delayed binding should be tested directly.

Minimum tests:

```text
1. A valid note can be spent by the intended adapter.
2. Changing adapter_id changes intent_hash and invalidates the proof/action binding.
3. The same proof cannot be reused with a different intent_hash.
4. The same nullifier cannot be consumed twice.
5. Wrong root_domain fails.
6. Wrong note_family or incompatible note family fails.
7. Wrong circuit_version fails.
8. Public input order mismatch fails.
9. Adapter-specific metadata is absent from generic commitment vectors.
10. Rust and TypeScript intent_hash vectors match.
```

For `PRIVATE_CLAIM_V1`, add tests showing that raw claim metadata is not present in the generic commitment.

## 15. Diagnostic requirements

Adapters using delayed binding should include diagnostics for:

* candidate set size
* root freshness
* timing between commitment and action
* adapter-specific action frequency
* amount or bucket uniqueness
* fee or expiry fingerprint
* event metadata
* relayer or submission route reuse

Delayed binding should not be reported as a complete privacy solution.

It is one metadata reduction strategy.

## 16. Review checklist

Before controlled devnet-alpha testing, the adapter should answer:

```text
Binding:
- Which fields are early-bound?
- Which fields are action-time bound?
- Is adapter_id excluded from generic commitments?
- Is adapter_id included in intent_hash?

Tree:
- What is the note_family?
- What is the root_domain?
- Does the root_domain fragment the set unnecessarily?

Nullifier:
- Is the nullifier global?
- Can the note be consumed by another adapter after use?

Intent:
- What does intent_hash bind?
- Is the action target included?
- Are fee, expiry, chain, and circuit version handled?

Metadata:
- What leaks at deposit time?
- What leaks at action time?
- What leaks through relayer/RPC/indexer behavior?

Tests:
- Are wrong-adapter and wrong-intent tests included?
- Are hash parity vectors included?
```

## 17. Non-goals

This document does not define:

* hidden exit commitments
* adapter registry mechanics
* x402 adapter details
* scoped nullifier design
* mainnet launch policy
* relayer decentralization
* production anonymity requirements

Those topics should stay in separate documents.

## 18. Summary

Delayed adapter binding is a small rule that reduces one important metadata leak.

The rule is:

```text
Bind notes to note families.
Bind actions to adapters.
```

Deposit-time commitments should stay generic within their note family.

Action-time `intent_hash` should bind the adapter and exact public action.

For Cirrus, this keeps the core model stable:

```text
proof + root + global_nullifier + intent_hash = valid private action
```

`WITHDRAW_SOL_V1` is the reference adapter.

`PRIVATE_CLAIM_V1` should be the first new adapter designed with delayed adapter binding from the start.

## Appendix A: Future topics

The following topics are related, but intentionally outside the M1.5 scope.

### Hidden exit commitment

A future withdrawal adapter may commit to a hidden recipient or action target before revealing it at action time.

That is a separate design topic.

It can reduce deposit-time recipient leakage, but it does not solve timing, relayer, or RPC metadata.

### Adapter registry

A future registry may store adapter ids, manifest hashes, verifier routes, and adapter status.

The registry should make adapter state explicit.

It should not imply production readiness.

### CLAIM_X402_V1

x402-style receipt claims should be built after `PRIVATE_CLAIM_V1`.

x402 introduces HTTP, facilitator, resource, and timing metadata that need their own adapter-specific review.

### Scoped nullifiers

Scoped nullifiers may be useful for non-value credential systems.

They are not part of the default model.

The default remains `GLOBAL_NULLIFIER_V1`.
