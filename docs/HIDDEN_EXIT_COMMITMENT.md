# Hidden Exit Commitment

## Status

Future adapter design note.

Scope: future adapter pattern.

Depends on:

* `docs/ADAPTER_MODEL.md`
* `docs/DELAYED_ADAPTER_BINDING.md`
* `docs/PRIVACY_SURFACE_MODEL.md`
* `docs/PRIVACY_DIAGNOSTIC_MODEL.md`

This document does not describe an implemented Cirrus feature.

It defines a future design pattern for adapters that need to bind an exit target
before action execution without revealing that target at commitment time.

Cirrus is devnet-alpha, unaudited, not mainnet-ready, not intended for real
funds, and makes no privacy guarantee.

## Motivation

Some private actions need to bind a future public target.

For withdrawal-style actions, the target may be a recipient address.

For claim-style actions, the target may be an account, program, verifier,
resource, receipt context, or settlement destination.

If the target is revealed too early, it can become a metadata link.

If the target is not bound at all, the action may be redirectable or ambiguous.

A hidden exit commitment is a middle path:

```text
bind the target early
reveal it later
prove the reveal matches the commitment
```

This pattern is useful when an adapter wants to prevent post-commitment target
substitution while avoiding deposit-time or commitment-time target disclosure.

## Core Decision

The core decision is:

```text
deposit-time: commit to an exit target
action-time: reveal the target and prove it matches the commitment
```

More specifically:

```text
commitment phase:
  note commitment includes an exit_commitment

action phase:
  public action includes the exit target
  proof shows the public target matches the hidden exit_commitment
```

The pattern delays disclosure.

It does not make the exit target permanently private.

## Core Warning

A hidden exit commitment is not a complete privacy solution.

It does not solve:

* timing linkability
* small candidate sets
* root freshness
* amount or bucket uniqueness
* relayer metadata
* RPC metadata
* recipient reuse
* action-target reuse
* fee or expiry fingerprinting
* account-list metadata
* event metadata
* infrastructure metadata

It may also reduce the effective anonymity set if hidden-exit notes are
distinguishable from generic notes.

The core privacy rule still applies:

```text
proof privacy is not action privacy
```

A valid proof can hide the witness while the action still exposes linkable
metadata.

## Relationship to Cirrus Adapter Model

The generic Cirrus adapter model is:

```text
proof + root + global_nullifier + intent_hash = valid private action
```

A hidden exit commitment does not replace this model.

It adds an optional commitment-time binding for a future action target.

With hidden exit commitment, the model becomes:

```text
note_commitment binds exit_commitment
proof proves exit target matches exit_commitment
intent_hash binds the public action
global_nullifier prevents replay
root proves membership in an accepted tree
```

For `WITHDRAW_SOL_V1`, the current mapping remains:

```text
nullifier_hash = global_nullifier
tx_hash = intent_hash
```

`WITHDRAW_SOL_V1` does not currently implement hidden exit commitments.

A future adapter such as `WITHDRAW_SOL_V2` may use this pattern.

## Relationship to Delayed Adapter Binding

Delayed adapter binding says:

```text
deposit-time: note_family + root_domain
action-time: adapter_id + intent_hash
```

A hidden exit commitment should not undo that design.

By default, a generic note commitment should not include `adapter_id`.

A hidden exit commitment binds a target, not the adapter.

Default rule:

```text
adapter_id MUST NOT be included in a generic note commitment by default.
adapter_id MUST be included in the action-time intent_hash.
```

Therefore, a hidden exit commitment should normally be structured as:

```text
note_commitment binds exit_commitment
exit_commitment binds exit target
intent_hash binds adapter_id and public action context
```

This allows the target to be pre-bound without making the note commitment
adapter-specific by default.

If an adapter wants to include `adapter_id` in the exit commitment, it must
document why that is required and how it affects anonymity-set partitioning.

The same review is required if the exit-commitment schema itself makes the note
distinguishable from generic notes in the same root domain.

## Anonymity Set Impact

Hidden exit commitment can introduce distinguishable note variants.

If only a subset of commitments use this pattern, observers may be able to
separate commitments into different groups:

```text
generic bearer notes
pre-bound target notes
adapter-specific target-commitment notes
```

This can reduce the effective anonymity set even if the exit target itself is
not revealed at commitment time.

An adapter using this pattern must document whether its commitment schema is
indistinguishable from other notes in the same `note_family` and `root_domain`.

If distinguishability cannot be avoided, diagnostics should report the effective
candidate set after this partitioning.

Default rule:

```text
hidden-exit variants SHOULD NOT create a distinguishable commitment class unless
the adapter explicitly documents the tradeoff.
```

This is especially important for delayed adapter binding.

A hidden exit commitment should not accidentally reveal:

```text
this note is for a specific adapter
this note is pre-bound while others are bearer-style
this note belongs to a smaller target-commitment subset
```

If a hidden-exit note family must be separate, the adapter should treat that
separate family as a smaller privacy set and report it clearly.

## Terminology

### Exit Target

The future public target of a private action.

Examples:

```text
recipient pubkey
settlement account
claim verifier account
claim action target
receipt redemption target
API/resource access target
cross-chain destination commitment
```

For a Solana withdrawal adapter, the exit target may be:

```text
recipient_pubkey
```

For a claim adapter, the exit target may be more abstract and adapter-defined.

### Exit Blinding

A private random value used to hide the exit target inside a commitment.

The blinding must be fresh and high entropy.

It must not be reused across notes.

### Exit Commitment

A commitment to the exit target and blinding.

Example conceptual form:

```text
exit_commitment = H(
  EXIT_COMMITMENT_DOMAIN,
  exit_target,
  exit_blinding
)
```

The exact hash function and encoding must be adapter-defined and versioned.

### Commitment-Time Binding

The target is bound before the action occurs, but the target itself is not
revealed.

### Action-Time Reveal

The target becomes public at execution time, and the proof verifies that it
matches the earlier commitment.

## Basic Construction

A simple hidden exit commitment pattern has three pieces:

```text
1. exit_commitment
2. note_commitment
3. action proof
```

### 1. Exit Commitment

The adapter computes:

```text
exit_commitment = H(
  EXIT_COMMITMENT_DOMAIN,
  exit_target,
  exit_blinding
)
```

The `exit_target` is the future action target.

The `exit_blinding` is private randomness.

The `EXIT_COMMITMENT_DOMAIN` prevents this commitment from being confused with
other hashes in the protocol.

### 2. Note Commitment

The note commitment includes `exit_commitment` as one private-bound field.

Example conceptual form:

```text
note_commitment = H(
  NOTE_COMMITMENT_DOMAIN,
  note_family,
  note_version,
  note_secret,
  note_bucket,
  exit_commitment,
  nullifier_material
)
```

This is illustrative, not a fixed implementation format.

The actual note commitment schema must be adapter- and note-family-specific.

If the schema makes hidden-exit notes distinguishable from non-hidden-exit notes,
the adapter must treat that as a privacy-surface decision and document it.

### 3. Action Proof

At action time:

* the public instruction includes the revealed target
* the witness includes `exit_blinding`
* the witness includes the note preimage
* the circuit recomputes `exit_commitment`
* the circuit checks that the recomputed `exit_commitment` matches the one bound
  inside the note commitment
* the public action is bound by `intent_hash`

Conceptual proof check:

```text
H(EXIT_COMMITMENT_DOMAIN, public_exit_target, exit_blinding)
  == exit_commitment
```

Then the action proceeds only if the full private action proof is valid.

## Visibility Model

A hidden exit commitment changes when data becomes visible.

| Field              | Commitment phase                           | Action phase              |
| ------------------ | ------------------------------------------ | ------------------------- |
| `exit_target`      | hidden                                     | public or adapter-defined |
| `exit_blinding`    | local private                              | local private             |
| `exit_commitment`  | public or commitment-bound                 | public or proof-bound     |
| `root`             | public                                     | public                    |
| `global_nullifier` | hidden until action                        | public at action          |
| `intent_hash`      | not known or not final                     | public at action          |
| `adapter_id`       | not bound by generic commitment by default | bound in `intent_hash`    |

The exact visibility depends on the adapter.

For withdrawal-style actions, the recipient is usually public at action time.

For claim-style actions, the target may be public, hashed public, delayed public,
or inferable from accounts/events.

## Intent Hash Interaction

Hidden exit commitment and `intent_hash` solve different problems.

The hidden exit commitment answers:

```text
Was this action target pre-bound by the note?
```

The `intent_hash` answers:

```text
Is the public action exactly the one authorized by the proof?
```

For an adapter using hidden exit commitment, both should be true.

Recommended binding:

```text
note_commitment binds exit_commitment
proof proves public_exit_target matches exit_commitment
intent_hash binds public_exit_target and adapter action context
```

This creates two layers:

```text
commitment-time target binding
action-time intent binding
```

The proof should not be reusable with a different target.

The action should not be executable with a target that changes the intended
settlement context.

## Example: Withdrawal-Style Adapter

For a future `WITHDRAW_SOL_V2`, the target may be a Solana recipient.

Conceptual fields:

```text
exit_target = recipient_pubkey
exit_commitment = H(
  EXIT_COMMITMENT_DOMAIN,
  recipient_pubkey,
  exit_blinding
)
```

At commitment time:

```text
note_commitment includes exit_commitment
recipient_pubkey is not public from the commitment itself
```

At withdrawal time:

```text
recipient_pubkey is public
proof verifies recipient_pubkey matches exit_commitment
intent_hash binds recipient_pubkey, relayer, fee, expiry, adapter_id, and context
```

This delays recipient disclosure until withdrawal.

It does not hide the recipient from the withdrawal transaction.

## Example: Claim-Style Adapter

For a future `PRIVATE_CLAIM_V1`, the target may not be a simple recipient.

It may be an adapter-defined action target.

Examples:

```text
claim verifier account
claim settlement account
receipt redemption target
resource access target
program-specific action context
```

A claim adapter should avoid exposing raw claim metadata by default.

A hidden target commitment may bind a target without revealing raw claim fields
early.

However, claim adapters must be especially careful with low-entropy data.

A commitment to a predictable claim domain, issuer, resource, or request id may
still be guessable if not blinded correctly.

Default rule:

```text
raw claim metadata should not be public by default
```

If a claim adapter uses hidden exit commitments, it must define:

* what the target is
* whether the target is revealed at action time
* whether the target has low entropy
* how the target is encoded
* whether the commitment includes enough blinding
* whether the commitment schema is distinguishable
* what event metadata is emitted
* what diagnostics apply

## Security Properties

A hidden exit commitment can provide the following security properties when
implemented correctly.

### Target Binding

The action target cannot be changed after commitment without invalidating the
proof.

Example:

```text
commitment binds recipient A
action attempts recipient B
proof fails
```

### Redirect Prevention

If an adapter requires a pre-bound recipient or target, a note holder cannot
redirect the action to an arbitrary target unless that target was already bound.

This can be useful for escrow-like, claim-like, or pre-authorized flows.

### Proof-to-Target Consistency

The circuit proves that the public target is the same target committed earlier.

This reduces ambiguity between the private note and the public action.

### Intent Consistency

The public target should still be included in `intent_hash`.

This prevents proof reuse against a different public action context.

## Privacy Properties

A hidden exit commitment can improve privacy only in a narrow sense:

```text
it can delay target disclosure
```

It does not provide permanent target privacy if the target is later revealed.

It does not make the action unlinkable.

It does not increase the candidate set by itself.

It does not hide timing.

It does not hide the relayer.

It does not hide the transaction account list.

It does not prevent recipient or target reuse.

It does not prevent external observers from correlating action-time metadata.

It may reduce the effective anonymity set if hidden-exit commitments create a
distinguishable note class.

The correct claim is:

```text
hidden exit commitment delays one metadata disclosure surface
```

The incorrect claim is:

```text
hidden exit commitment makes withdrawals private
```

## Reuse Rules

Exit commitments should not be reused.

The same `exit_commitment` across multiple notes or actions can become a strong
linkability signal.

Default rules:

```text
exit_blinding MUST be fresh per note.
exit_commitment SHOULD be unique per note.
exit_commitment reuse SHOULD be diagnostically flagged.
```

Even if the same exit target is intended, a new blinding should be used.

Example:

```text
same recipient + fresh blinding = different exit_commitment
same recipient + same blinding = reused exit_commitment
```

The second case should be treated as a metadata problem.

## Encoding Rules

The adapter must define canonical encoding.

For Solana pubkeys:

```text
use the full 32-byte public key
do not truncate
do not stringify before hashing unless explicitly specified
do not rely on locale-dependent encoding
```

For structured targets:

```text
domain separate every field
version the schema
define byte order
define field lengths
define optional-field handling
define hash input order
```

For low-entropy targets:

```text
do not hash raw low-entropy values without blinding
```

A hash of predictable data can still be linkable.

## Domain Separation

Hidden exit commitments require explicit domain separation.

At minimum, define separate domains for:

```text
NOTE_COMMITMENT_DOMAIN
EXIT_COMMITMENT_DOMAIN
INTENT_HASH_DOMAIN
NULLIFIER_DOMAIN
```

These domains should be versioned.

Example conceptual domains:

```text
CIRRUS_EXIT_COMMITMENT_V1
CIRRUS_NOTE_COMMITMENT_V1
CIRRUS_WITHDRAW_SOL_V2_INTENT_V1
CIRRUS_PRIVATE_CLAIM_V1_INTENT_V1
```

The exact strings or field encodings must be specified before implementation.

## Relationship to Transferability

Pre-binding an exit target changes note behavior.

If a note is intended to be freely transferable, binding a recipient at
commitment time may reduce flexibility.

There are two broad modes:

```text
bearer note:
  whoever holds the secret can choose the action target later

pre-bound note:
  the future target is committed when the note is created
```

Hidden exit commitment is more natural for pre-bound notes.

For bearer notes, hidden exit commitment may be optional or undesirable.

An adapter must explicitly state which behavior it wants.

Default Cirrus interpretation:

```text
WITHDRAW_SOL_V1 = bearer-style reference adapter
future adapters = may choose pre-bound target semantics if documented
```

## Adapter Applicability

Not every adapter needs hidden exit commitments.

### Good candidates

Hidden exit commitment may be useful for:

* pre-bound withdrawal recipients
* escrow-like private settlement
* receipt redemption to a predetermined account
* private claim settlement with a known future target
* flows where target substitution is a security concern
* flows where deposit-time target disclosure is unnecessary

### Poor candidates

Hidden exit commitment may be unnecessary or harmful for:

* simple bearer withdrawals
* flows where the user should choose the target at action time
* flows where target binding fragments the set
* flows where target commitment reuse is likely
* flows where action-time target disclosure already dominates privacy loss
* adapters that cannot define canonical target encoding
* adapters where hidden-exit notes are distinguishable and create a small subset

## Event Policy

Deposit or commitment events must not emit:

* raw exit target
* exit blinding
* note secret
* nullifier preimage
* witness data
* raw private claim metadata
* local note file path
* private randomness

Action events may include the public target only if the adapter requires it.

Even then, event fields should be minimized.

For claim-style adapters, default events should avoid raw:

* claim domain
* issuer
* resource
* user identifier
* request id
* receipt id
* memo
* API route

If any of these are required, the adapter must document why.

## Diagnostic Requirements

Hidden exit commitment introduces new diagnostic surfaces.

A future adapter using this pattern should define diagnostics for:

```text
EXIT_COMMITMENT_REUSE
TARGET_REUSE
TARGET_DISCLOSURE_TIMING
ACTION_TARGET_SURFACE
EVENT_METADATA
CANDIDATE_SET
ROOT_FRESHNESS
TIMING_LINKABILITY
RELAYER_SUBMISSION
SNAPSHOT_HYGIENE
ANONYMITY_SET_PARTITIONING
```

### Exit Commitment Reuse

Flag if the same `exit_commitment` appears more than once.

Suggested findings:

```text
same exit_commitment reused across notes       -> HIGH
same target observed repeatedly at action time -> ELEVATED or HIGH
missing commitment history                     -> UNKNOWN
```

### Target Disclosure Timing

Report when the target becomes public.

Examples:

```text
target hidden at commitment, public at action
target public at commitment
target public through event
target inferable from account list
target unknown due to missing data
```

### Target Reuse

Report repeated public targets.

Examples:

```text
same recipient reused across withdrawals
same claim target reused across claims
same verifier context repeatedly used
```

Target reuse does not necessarily mean a protocol bug exists.

It is a practical linkability signal.

### Account-List Surface

On Solana, account lists can reveal action shape.

A hidden target commitment does not hide accounts that must be passed to the
instruction.

Diagnostics should report when the account list reveals the action target or
target class.

### Anonymity-Set Partitioning

Diagnostics should report whether hidden-exit commitments create a separate
candidate set.

Examples:

```text
hidden-exit note class indistinguishable from generic notes -> OBSERVED
hidden-exit note class distinguishable from generic notes   -> ELEVATED or HIGH
missing note-family history                                -> UNKNOWN
small hidden-exit-only candidate set                       -> HIGH
```

A hidden target is less useful if the note class itself reveals a smaller group.

### Unknown Data

Missing data must be reported as:

```text
UNKNOWN
```

not as a positive privacy signal.

## Test Requirements

A future implementation should include tests for both correctness and
diagnostic behavior.

### Correctness Tests

Minimum correctness tests:

```text
1. Valid target + valid blinding passes.
2. Wrong target fails.
3. Wrong blinding fails.
4. Wrong exit commitment fails.
5. Changed recipient/action target changes intent_hash.
6. Proof cannot be reused with a different target.
7. Public input order is stable.
8. Domain separation is enforced.
9. Full Solana pubkey encoding is used.
10. Truncated target encoding is rejected.
```

### Event Tests

Minimum event tests:

```text
1. Deposit event does not emit raw exit target.
2. Deposit event does not emit exit blinding.
3. Deposit event does not emit note secret.
4. Deposit event does not emit nullifier preimage.
5. Claim adapter event does not emit raw private claim metadata by default.
```

### Diagnostic Tests

Minimum diagnostic tests:

```text
1. Reused exit_commitment is flagged.
2. Missing commitment history returns UNKNOWN.
3. Target reuse is reported.
4. Target disclosure phase is reported.
5. Account-list target leakage is reported when detectable.
6. Diagnostic report does not include exit_blinding.
7. Diagnostic report does not include note secret.
8. Diagnostic report does not include nullifier preimage.
9. Distinguishable hidden-exit note class is reported.
10. Hidden-exit-only candidate set is reported separately when detectable.
```

## Implementation Staging

This pattern should not be implemented by rewriting `WITHDRAW_SOL_V1`
immediately.

A safer staging path:

### Stage 1: Documentation

Define the model, terminology, and adapter requirements.

Artifact:

```text
docs/HIDDEN_EXIT_COMMITMENT.md
```

### Stage 2: Test Vectors

Create standalone hash/encoding vectors.

Vectors should cover:

* Solana pubkey target
* fresh blinding
* wrong target
* wrong blinding
* domain separation
* canonical encoding
* distinguishable versus generic note schema, if applicable

### Stage 3: Experimental Circuit

Build a small experimental circuit that proves:

```text
H(EXIT_COMMITMENT_DOMAIN, public_target, exit_blinding)
  == exit_commitment
```

This should be separate from the working `WITHDRAW_SOL_V1` path at first.

### Stage 4: Adapter Proposal

Define a future adapter that actually needs this pattern.

Possible candidate:

```text
WITHDRAW_SOL_V2
```

or an adapter-specific claim flow.

### Stage 5: Integration

Only after tests and vectors exist, integrate into an adapter.

Do not break the existing `WITHDRAW_SOL_V1` devnet-alpha path.

## Current `WITHDRAW_SOL_V1` Position

`WITHDRAW_SOL_V1` currently binds the public withdrawal action through `tx_hash`.

It does not bind a hidden recipient at commitment time.

This means:

```text
recipient is chosen and made public at withdrawal time
tx_hash binds recipient into the public action context
proof verifies the note/nullifier/root relationship
```

That is acceptable for the current reference adapter.

Hidden exit commitment is a future pattern, not a retroactive requirement for
`WITHDRAW_SOL_V1`.

## Future `WITHDRAW_SOL_V2` Consideration

A future `WITHDRAW_SOL_V2` may add hidden exit commitment if the adapter needs
pre-bound recipients.

Possible conceptual public inputs:

```text
[root, global_nullifier, intent_hash]
```

Possible private witness fields:

```text
note_secret
nullifier_material
merkle_path
exit_blinding
exit_target_preimage_fields
```

Possible public action fields:

```text
recipient_pubkey
relayer_pubkey
fee
expiry_slot
adapter_id
circuit_version
```

The circuit would check:

```text
note commitment is in root
global_nullifier derives from note material
exit_commitment derives from recipient_pubkey and exit_blinding
intent_hash binds recipient_pubkey and action context
```

This is only a design direction.

It is not an implementation commitment.

## Future `PRIVATE_CLAIM_V1` Consideration

A future `PRIVATE_CLAIM_V1` may use a related pattern for action targets.

However, claim adapters should avoid raw claim metadata by default.

A claim target commitment should be reviewed for:

* low-entropy fields
* predictable domains
* issuer concentration
* resource uniqueness
* action frequency
* event metadata
* account-list leakage
* external facilitator metadata
* hidden-exit note-class distinguishability

Claim adapters should not treat hashing as sufficient privacy.

A hash of a predictable claim field can still be linkable.

## Failure Modes

### Reused Blinding

If the same `exit_blinding` is reused with the same target, the same
`exit_commitment` may appear again.

This creates a linkability signal.

### Low-Entropy Target

If the target is predictable and the blinding is weak, observers may guess the
target.

### Adapter-Specific Commitment Leakage

If `adapter_id` or raw adapter metadata is included in a generic note
commitment, deposits may be partitioned by adapter.

This can weaken delayed adapter binding.

### Distinguishable Hidden-Exit Note Class

If hidden-exit notes have a different commitment schema from generic notes,
observers may identify them as a separate class.

This can reduce the effective anonymity set even if the target is hidden.

### Event Overexposure

If deposit events emit the raw target, hidden exit commitment provides no
deposit-time privacy benefit.

### Account-List Leakage

If the target is hidden in the commitment but revealed through required accounts
at the same phase, the pattern may not provide the intended delay.

### Intent Mismatch

If the public target is proven against `exit_commitment` but not included in
`intent_hash`, the proof may not be bound to the full action context.

### Transferability Loss

If notes are expected to be bearer instruments, pre-binding the target may make
them less flexible.

This may be acceptable for some adapters and unacceptable for others.

## Review Checklist

Before an adapter uses hidden exit commitment, it must answer:

1. What is the exit target?
2. Is the target public at action time?
3. Is the target hidden at commitment time?
4. Is the target low entropy?
5. What is the exit commitment formula?
6. What domain separator is used?
7. What exact canonical encoding is used?
8. Is `exit_blinding` fresh per note?
9. Can the same exit commitment be reused?
10. Does the note remain transferable?
11. Is `adapter_id` excluded from the generic note commitment?
12. Is `adapter_id` included in `intent_hash`?
13. Is the public target included in `intent_hash`?
14. Does the hidden-exit schema create a distinguishable note class?
15. Does the hidden-exit variant partition the effective anonymity set?
16. Do events reveal the target earlier than intended?
17. Do account lists reveal the target earlier than intended?
18. What diagnostics report target reuse?
19. What diagnostics report exit commitment reuse?
20. What diagnostics report anonymity-set partitioning?
21. What data becomes `UNKNOWN` if snapshots are missing?
22. What tests prove wrong-target failure?
23. What tests prove proof non-reuse across targets?

An adapter should not implement hidden exit commitment until this review exists.

## Non-Goals

This document does not define:

* permanent recipient privacy
* encrypted account execution
* confidential balances
* hidden Solana account lists
* relayer privacy
* RPC privacy
* production anonymity thresholds
* mainnet readiness
* universal private transfers
* a replacement for `intent_hash`
* a replacement for nullifier replay protection
* a generic claim metadata privacy solution
* legal or compliance policy

Those topics require separate design notes.

## Open Questions

* Should hidden exit commitment be part of a generic note family or only
  adapter-specific note families?
* Should `WITHDRAW_SOL_V2` use pre-bound recipients, or should withdrawals
  remain bearer-style?
* How should target commitments be represented for claim adapters?
* Should target commitments support optional target reveal?
* Should diagnostics treat repeated target as `HIGH` by default?
* Should target commitment reuse be `HIGH` or `CRITICAL`?
* How should low-entropy claim targets be handled?
* Should target commitments include target type without including `adapter_id`?
* How should Cirrus avoid fragmenting the anonymity set by target-commitment
  variants?
* Which test vectors are required before implementation?
* Can hidden-exit commitments be made indistinguishable from generic notes in
  the same note family?
* If hidden-exit notes require a separate note family, what is the minimum
  candidate set needed before the adapter is useful?

## Summary

A hidden exit commitment is an optional future pattern for Cirrus adapters.

It lets an adapter:

```text
bind a future action target before execution
without revealing that target at commitment time
```

At action time, the target may become public, and the proof verifies that the
public target matches the earlier hidden commitment.

The pattern is useful for adapters that need pre-bound targets, but it is not a
complete privacy solution.

It delays one metadata disclosure surface.

It does not hide timing, relayers, RPC behavior, account lists, recipient reuse,
or action-time target visibility.

It can also reduce the effective anonymity set if hidden-exit notes are
distinguishable from generic notes.

For Cirrus, the correct role of hidden exit commitment is narrow:

```text
commitment-time target binding
action-time target verification
diagnostic reporting of the remaining metadata surface
```

`WITHDRAW_SOL_V1` does not need to be changed to satisfy this document.

A future adapter may adopt the pattern only after its target semantics,
encoding, event policy, anonymity-set impact, diagnostics, and tests are clearly
defined.
