# Privacy Surface Model

Status: M1.6 design note
Scope: devnet-alpha architecture
Depends on: `docs/ADAPTER_MODEL.md`, `docs/DELAYED_ADAPTER_BINDING.md`

Cirrus is a metadata-aware ZK protocol for private settlement and claim adapters.

A zero-knowledge proof hides the private witness.

It does not hide every public surface created by the transaction, the adapter, the relayer, the indexer, or the user’s behavior.

This document defines how Cirrus describes those surfaces.

The core principle is:

```text
proof privacy is not action privacy
```

An adapter is not complete just because the circuit verifies.

An adapter must also describe what information becomes visible, when it becomes visible, and which metadata can reduce the effective anonymity set.

## 1. Purpose

The purpose of this model is to give every Cirrus adapter a common privacy-surface vocabulary.

For each adapter, reviewers should be able to answer:

```text
What does the proof hide?
What does the action reveal?
What is public at deposit time?
What is public at action time?
What is visible to infrastructure?
What can partition the anonymity set?
Which diagnostics are required?
```

This document does not claim that Cirrus can remove all metadata.

It defines how metadata is identified, minimized, and reported.

This model is descriptive first. It identifies and reports surfaces; it does not automatically enforce a minimum anonymity threshold.

## 2. Privacy surface

A privacy surface is any field, account, event, timing pattern, infrastructure interaction, or derived signal that can help an observer link private actions.

The surface includes more than circuit public inputs.

It includes:

* instruction names
* account lists
* program-derived addresses
* emitted events
* commitments
* accepted roots
* nullifier hashes
* `intent_hash` values
* amount or bucket choices
* fees
* expiry slots or validity windows
* recipients or action targets
* relayers
* RPC/submission route behavior
* indexer and snapshot metadata
* adapter labels
* timing patterns

A ZK proof can be valid while the privacy surface is still weak.

That is the main reason this document exists.

## 3. Visibility levels

Cirrus uses a small set of visibility levels.

### Public

Visible on-chain or directly inferable from the transaction.

Examples:

* program id
* instruction name
* account list
* root
* nullifier hash
* public recipient
* public event fields
* fee payer
* transaction slot

### Delayed public

Hidden or not revealed at one phase, then revealed later.

Example:

```text
recipient hidden at deposit time
recipient public at withdrawal time
```

Delayed public data can still affect privacy.

It only changes when the data becomes visible.

### Hashed public

A hash or commitment is public, while the preimage is not.

Examples:

* note commitment
* nullifier hash
* `intent_hash`
* claim action hash
* resource hash

Hashed public data can still carry linkability risk.

It can be linkable if the preimage space is small, predictable, or reused.

### Local private

Known only to the user, client, or prover unless leaked elsewhere.

Examples:

* note secret
* nullifier preimage
* Merkle path
* witness input
* proof-generation files
* local note records

Local private data must not be logged, committed, emitted, or uploaded by default.

### Operator or infrastructure visible

Not visible to all on-chain observers, but visible to a relayer, RPC provider, hosted prover, indexer, API server, or other infrastructure component.

Examples:

* IP address
* request timing
* proof submission payload
* recipient before transaction submission
* relayer request metadata
* retry pattern
* RPC query pattern
* snapshot fetch behavior

This category matters because infrastructure metadata can defeat otherwise good on-chain privacy.

## 4. Time phases

Cirrus separates privacy surfaces by phase.

### Deposit or commitment phase

This is when a note or claim commitment enters a tree.

Possible surfaces:

* commitment
* note family
* root domain
* amount bucket or denomination
* deposit timing
* depositor/funding wallet
* tree index or insertion order
* event fields
* RPC metadata

The deposit phase should avoid exposing the final adapter action.

This follows the delayed adapter binding rule:

```text
deposit-time: note_family + root_domain
action-time: adapter_id + intent_hash
```

### Root phase

This is when commitments are grouped into accepted roots.

Possible surfaces:

* accepted root
* root age
* root submitter
* root batch size
* candidate set size
* snapshot provenance
* tree domain
* insertion history

A fresh root with a small candidate set can make timing linkage easier.

Root acceptance is part of the privacy surface, not only a correctness check.

### Action phase

This is when a private action is executed.

Possible surfaces:

* adapter id
* instruction name
* account list
* root
* nullifier hash
* `intent_hash`
* recipient or action target
* relayer
* fee
* expiry
* event fields
* transaction slot

The action phase must fully bind the adapter.

Delayed binding is not delayed authorization.

The adapter must be bound before the action is executed.

### Infrastructure phase

This is everything around the transaction.

Possible surfaces:

* RPC endpoint
* IP address
* simulation calls
* relayer request logs
* hosted prover logs
* indexer queries
* snapshot downloads
* retries
* failed transactions
* browser or wallet metadata

Some of these are outside the on-chain protocol, but they still affect practical privacy.

## 5. Adapter surface layers

Every adapter should describe its surface across the following layers.

### Instruction layer

The instruction name and instruction data may reveal the adapter.

For example:

```text
withdraw_zk
private_claim
claim_x402
```

This may be acceptable at action time.

It should not leak final action intent at deposit time unless the adapter explicitly requires it.

### Account layer

Account lists are public.

They can reveal:

* pool
* config
* token mint
* recipient
* relayer
* verifier route
* adapter-specific state
* registry entries
* associated token accounts

On Solana, account lists can reveal action shape even when instruction data and events are minimized.

Account shape can fingerprint an adapter even if the event is minimal.

### Event layer

Events are intentionally public.

They should be treated as a privacy surface.

Avoid raw metadata in default events:

* raw claim domain
* raw issuer
* raw user id
* raw resource URL
* raw invoice id
* raw memo
* raw API route
* note secret
* nullifier preimage
* witness data

A minimal event is preferred.

### Commitment layer

Commitments hide preimages but can still reveal structure.

Commitment design may leak:

* note family
* amount bucket
* tree domain
* adapter-specific labels
* claim type
* issuer or resource hints

Generic commitments should avoid binding `adapter_id` unless a separate design note justifies early binding.

### Root layer

Roots define the candidate set.

Root metadata may reveal:

* root freshness
* batch size
* root submitter
* tree family
* compatible commitment count
* insertion timing

An accepted root with only a few compatible commitments gives weak practical privacy.

### Nullifier layer

Nullifier hashes are public anti-replay markers.

They should prevent double use without revealing which commitment was spent.

Nullifiers can still reveal:

* action count
* timing
* adapter usage
* replay attempts
* failed or duplicate submissions

The default Cirrus policy is `GLOBAL_NULLIFIER_V1`.

### Intent layer

`intent_hash` binds the proof to the public action.

It should prevent a valid proof from being reused for a different action.

The hash schema itself is a privacy surface.

If the preimage fields are low-entropy, predictable, or repeated, observers may infer patterns from surrounding data even if the hash remains opaque.

### Amount or bucket layer

Amounts and buckets can partition the set.

Fixed denominations can improve grouping, but only if enough compatible notes exist.

Unique amounts are usually bad for privacy.

Adapters should prefer buckets when exact amounts are not required.

### Fee and expiry layer

Fee and expiry values can fingerprint users or clients.

Risky patterns:

* unique fee values
* exact custom expiry slots
* user-specific fee strategies
* client-specific compute/priority settings

Adapters should use standard fee and expiry policies where possible.

### Recipient or action-target layer

The recipient or action target may be public at action time.

Risks:

* recipient reuse
* recipient linked to funding wallet
* recipient equals relayer
* recipient created immediately before withdrawal
* action target reused across claims
* account graph reveals the user

A public recipient does not break proof correctness, but it can reduce practical privacy.

### Relayer and submission layer

A relayer can reduce on-chain fee-payer linkage, but it creates infrastructure metadata.

The relayer may observe:

* request timing
* recipient
* proof payload
* selected pool
* retry behavior
* IP or network metadata

Relayers are privacy surfaces, not only UX helpers.

### RPC and indexer layer

RPC providers and indexers may observe query patterns.

Examples:

* fetching roots
* fetching commitment events
* checking nullifier status
* downloading snapshots
* simulating transactions
* retrying failed submissions

Local proving does not remove RPC metadata by itself.

## 6. Effective anonymity set

Cirrus should avoid treating root size as the only anonymity metric.

A more useful mental model is:

```text
effective set =
  accepted root candidates
∩ compatible note family
∩ compatible root domain
∩ amount or bucket
∩ adapter/action type
∩ timing window
∩ relayer/submission pattern
∩ recipient/action-target behavior
∩ fee/expiry pattern
∩ observable infrastructure metadata
```

This is not an exact formula.

It is a review model.

The point is that each public or observable surface can partition the set.

A large root is not enough if every other field is unique.

## 7. Surface minimization rules

Cirrus adapters should follow these rules by default.

### Rule 1: Keep deposit metadata generic

Deposit or commitment phase should bind to note family and root domain, not final adapter intent.

Preferred:

```text
VALUE_NOTE_TREE_V1
CLAIM_NOTE_TREE_V1
```

Avoid:

```text
WITHDRAW_SOL_V1_TREE
CLAIM_X402_V1_TREE
```

### Rule 2: Bind the action through `intent_hash`

The adapter must be fully bound before execution.

The action-time `intent_hash` should include `adapter_id` and the fields needed for correctness and replay resistance.

### Rule 3: Minimize events

Events should expose only what the adapter needs.

Do not emit raw claim or resource metadata by default.

### Rule 4: Prefer buckets over unique values

Amounts, fees, expiry slots, and similar parameters should avoid unnecessary uniqueness.

Unique values can fingerprint users.

### Rule 5: Treat relayers as metadata surfaces

Relayers should be documented in the adapter model.

The question is not only whether the relayer can steal funds.

The question is also what the relayer can learn.

### Rule 6: Missing diagnostic data is `UNKNOWN`

Diagnostics should not convert missing data into a positive signal.

If the candidate set, timing, root freshness, or relayer metadata cannot be evaluated, the result should be `UNKNOWN`.

### Rule 7: Avoid public privacy overclaims

Adapter docs should describe surfaces and limitations directly.

Avoid language such as:

```text
anonymous
untraceable
guaranteed private
fully hidden
safe
```

Prefer:

```text
metadata-aware
diagnostic
devnet-alpha
known limitations
candidate set
linkability surface
```

## 8. WITHDRAW_SOL_V1 surface

`WITHDRAW_SOL_V1` is the current reference adapter.

Current formula:

```text
proof + root + nullifier_hash + tx_hash = valid withdrawal
```

Generic mapping:

```text
nullifier_hash = global_nullifier
tx_hash = intent_hash
```

### Hidden by the proof

The proof hides:

* note secret
* nullifier preimage
* Merkle path
* leaf index
* witness values

### Public at action time

The action exposes or may expose:

* root
* nullifier hash
* `tx_hash`
* withdrawal instruction
* recipient
* relayer
* fee
* denomination
* expiry slot
* pool/config accounts
* transaction slot
* event fields

### Main surfaces

#### Root surface

The accepted root defines the candidate set.

If the root is fresh and contains few compatible commitments, timing linkage becomes easier.

#### Nullifier surface

The nullifier prevents replay.

It also publicly marks that one note was consumed.

#### Recipient surface

The recipient is public at withdrawal time.

Recipient reuse or recipient funding patterns can link withdrawals.

#### Relayer surface

The relayer can reduce fee-payer linkage.

It can still observe request metadata.

#### Fee and expiry surface

Fee and expiry values are bound into the withdrawal intent.

Unique values may still fingerprint a user or client pattern.

#### Timing surface

A deposit followed quickly by a withdrawal can be easier to link, especially in a small pool.

### Required diagnostics

`WITHDRAW_SOL_V1` should consider:

* candidate set size
* accepted root age
* deposit-to-withdraw timing
* same-denomination candidate count
* fee/expiry uniqueness
* recipient reuse
* relayer reuse
* snapshot provenance

## 9. PRIVATE_CLAIM_V1 surface expectations

`PRIVATE_CLAIM_V1` should be designed with this surface model from the start.

Its goal is to prove knowledge of a private claim commitment, or consume a private claim, without exposing raw claim metadata by default.

Expected formula:

```text
proof + root + global_nullifier + intent_hash = valid private claim
```

### Expected hidden data

A claim adapter may hide:

* claim secret
* claim nullifier preimage
* claim leaf preimage
* Merkle path
* raw claim metadata
* raw issuer/resource/user fields, when possible

### Expected public data

A minimal action may expose:

* adapter id
* root
* global nullifier
* `intent_hash`
* claim verification event
* verifier/program context
* transaction slot

### Default claim policy

By default, `PRIVATE_CLAIM_V1` should avoid exposing:

* raw claim domain
* raw issuer
* raw resource
* raw user identifier
* raw request id
* raw receipt id
* raw memo

Use hashes or local-only data unless disclosure is required by the adapter.

### Minimal event shape

A minimal event may look like:

```text
PrivateClaimVerified {
  adapter_id,
  root,
  global_nullifier
}
```

Adapter-specific claim data should be added only when necessary and documented as a public surface.

### Required diagnostics

`PRIVATE_CLAIM_V1` should consider:

* claim candidate set size
* root freshness
* claim action frequency
* repeated action target
* event metadata
* issuer/resource hash uniqueness
* timing between commitment and claim
* relayer or submission route reuse
* snapshot/indexer hygiene

## 10. Adapter author requirements

Every adapter should include a privacy-surface section.

Minimum required answers:

```text
Phases:
- What is public at deposit/commitment time?
- What is public at root acceptance time?
- What is public at action time?
- What is visible to infrastructure?

Fields:
- Which fields are public?
- Which fields are delayed public?
- Which fields are hashed public?
- Which fields remain local private?
- Which fields are operator/infrastructure visible?

Binding:
- Is adapter_id excluded from generic commitments?
- Is adapter_id included in intent_hash?
- Which fields are bound by intent_hash?

Events:
- What events are emitted?
- Do they expose raw metadata?
- Can any event field be hashed, delayed, or removed?

Diagnostics:
- Which diagnostics are required?
- What returns UNKNOWN?
- What conditions return HIGH or ELEVATED findings?
```

If an adapter cannot answer these questions, its privacy surface is not yet specified.

## 11. Review checklist

Before controlled devnet-alpha testing, an adapter should be reviewed against this checklist.

```text
Deposit surface:
- Does the commitment reveal adapter_id?
- Does it reveal raw claim or resource metadata?
- Does it reveal a unique amount or bucket?

Root surface:
- Which root_domain is used?
- Does the root_domain fragment the set?
- How fresh is the accepted root?
- How many compatible commitments exist?

Action surface:
- Which adapter is executed?
- Which accounts identify the action?
- Which public inputs are visible?
- Which event fields are emitted?

Intent surface:
- What does intent_hash bind?
- Can the same proof be interpreted as another action?
- Are low-entropy fields handled carefully?

Nullifier surface:
- Is the nullifier global?
- Can the note be consumed again elsewhere?
- Are replay attempts visible?

Recipient or target surface:
- Is the target public?
- Is it reused?
- Is it linked to funding behavior?

Relayer/RPC surface:
- Is a relayer required?
- What does the relayer learn?
- What RPC or indexer queries are required?

Diagnostics:
- What can be measured?
- What cannot be measured?
- What returns UNKNOWN?
```

This checklist is intentionally practical.

Detailed threat models can live in adapter-specific docs.

## 12. Testing expectations

Privacy-surface rules should be testable where possible.

Minimum test targets:

* generic commitments do not include `adapter_id`
* generic commitments do not include raw claim metadata
* changing `adapter_id` changes `intent_hash`
* changing action target changes `intent_hash`
* public input order is fixed
* event fields do not include prohibited raw metadata
* Rust and TypeScript hash vectors match
* diagnostic code returns `UNKNOWN` when required data is missing
* wrong intent fails
* wrong root domain or incompatible root domain fails
* reused nullifier fails

Not every privacy property can be tested automatically.

But surfaces that are encoded in commitments, events, hashes, or public inputs should have direct tests.

## 13. Non-goals

This document does not define:

* a complete anonymity metric
* relayer decentralization
* RPC privacy infrastructure
* hidden exit commitments
* x402 adapter details
* cross-chain claim policy
* mainnet readiness requirements
* legal or compliance policy

Those should remain separate design notes.

## 14. Summary

Cirrus adapters must be reviewed as privacy surfaces, not only as proof systems.

The core distinction is:

```text
proof privacy != action privacy
```

A valid proof can hide the witness while the transaction still reveals useful metadata.

The adapter model handles proof binding.

Delayed adapter binding reduces early adapter leakage.

The privacy surface model describes what remains visible.

For Cirrus, the long-term discipline is:

```text
define the action
bind the intent
consume the nullifier
check the root
minimize the surface
report the diagnostics
```

`WITHDRAW_SOL_V1` is the current reference surface.

`PRIVATE_CLAIM_V1` should be the first new adapter designed with this model from the start.

## Appendix A: Future surfaces

The following topics are related, but intentionally outside the M1.6 core model.

### Hidden exit commitment

A future withdrawal adapter may delay recipient disclosure by committing to an exit target before revealing it at withdrawal time.

This changes the recipient surface.

It does not remove timing, relayer, or RPC surfaces.

### CLAIM_X402_V1

x402-style claims introduce HTTP, facilitator, resource, and timing metadata.

Those fields should be reviewed in an adapter-specific surface model after `PRIVATE_CLAIM_V1`.

### Adapter registry

A registry may make adapter id, status, manifest hash, verifier route, and circuit version public.

That registry is itself a privacy surface.

### Confidential token adapters

A confidential token adapter may hide amounts while still exposing accounts or action shape.

Amount privacy should not be confused with full action privacy.

### Cross-chain claims

Cross-chain claim adapters may expose source-chain timing, bridge/finality data, replay domains, and proof provenance.

Those surfaces require a separate review.
