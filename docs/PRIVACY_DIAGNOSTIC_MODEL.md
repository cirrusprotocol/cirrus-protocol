# Privacy Diagnostic Model for Cirrus ZK Settlement Flows

## Status

Research note.

This document does not define a privacy proof, a completed mitigation strategy,
or a guarantee that a Cirrus action is unlinkable.

It defines a conservative diagnostic model for reasoning about public metadata
around Cirrus ZK settlement and claim flows.

Cirrus is a devnet-alpha research prototype. It is unaudited, not mainnet-ready,
not intended for real funds, and makes no privacy guarantee.

## Motivation

A valid ZK proof is a correctness signal.

It can show that a private statement was satisfied without revealing the witness.
In Cirrus, the current `WITHDRAW_SOL_V1` path also checks root membership,
nullifier replay protection, and tx_hash-bound settlement.

That is not the same as practical privacy.

An action can be cryptographically valid while still being easy to link through
public metadata such as timing, root freshness, amount bucket, relayer behavior,
recipient behavior, fee patterns, expiry values, snapshot metadata, or
infrastructure usage.

The purpose of the diagnostic model is to make those conditions visible before
they are mistaken for privacy.

## Relationship to Metadata Linkability

The metadata linkability model asks:

```text
Which public fields help an observer narrow the path from a later action back to an earlier commitment?
```

This diagnostic model asks the next question:

```text
Can Cirrus report those narrowing effects in a conservative, reproducible way?
```

The diagnostic layer does not prove privacy.

It produces warnings, measurements, and review signals that help developers and
operators understand when a ZK action may be practically linkable despite being
valid.

## Non-Goals

This model does not attempt to:

* prove anonymity
* assign a formal privacy guarantee
* replace audits
* replace threat modeling
* block all unsafe usage at the program layer
* collect private user data
* inspect secret notes or witnesses
* rely on relayer-side private logs
* claim that a less severe diagnostic report means an action is private

A diagnostic report is a warning system, not a privacy certificate.

## Core Principle

Cirrus should treat proof validity and practical privacy as separate properties.

```text
Proof validity answers:
Is this private statement satisfied?

Privacy diagnostics ask:
How much public metadata narrows the possible source set?
```

The verifier can be correct while the action remains practically linkable.

## Diagnostic Layer Placement

Privacy diagnostics are primarily an off-chain layer.

The on-chain program can enforce correctness properties:

* allowed root
* proof verification
* nullifier not previously consumed
* tx_hash / intent binding
* adapter-specific settlement checks
* fail-closed behavior

The on-chain program cannot fully evaluate practical privacy because many
linkability signals are not available to it:

* historical timing patterns
* root batch size over time
* relayer concentration
* recipient reuse
* RPC behavior
* snapshot publication behavior
* cross-adapter usage patterns
* external payment or claim metadata

Therefore, the first privacy diagnostic layer should live in the indexer, CLI,
client, or operator tooling.

## Diagnostic Scope

The first diagnostic target is the current implemented adapter:

```text
WITHDRAW_SOL_V1
```

Future adapters may define their own diagnostic schema. Examples may include:

```text
PRIVATE_CLAIM_V1
CLAIM_X402_V1
WITHDRAW_SPL_V1
CROSS_CHAIN_CLAIM_V1
```

These names are examples of possible future action families, not launch promises
or a finalized roadmap.

Each adapter should define:

* which public fields it exposes
* which fields narrow the effective anonymity set
* which fields are required for safety
* which fields exist only for convenience, indexing, or debugging
* which diagnostics should be reviewed before the adapter is expanded

## Practical Model: Effective Anonymity Set

The diagnostic model treats public metadata as filters over a possible source
set.

A simple working model:

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

This is not a formal privacy proof.

It is a practical review model. Each public field can reduce the number of
plausible source commitments.

A useful diagnostic should therefore report not only whether a proof was valid,
but also which public filters made the action easier to cluster.

## Diagnostic Vocabulary and Finding Levels

The model avoids saying that an action is “safe,” “private,” or “low risk.”

Instead, diagnostic levels should be conservative:

```text
CRITICAL
HIGH
ELEVATED
OBSERVED
UNKNOWN
```

These levels classify observed metadata conditions, not user safety. A less
severe finding does not mean that an action is private or unlinkable.

### CRITICAL

A public observer can likely narrow the source set to one or almost one
candidate.

Examples:

* candidate set size is 1
* one fresh commitment appears before one root and one withdrawal
* unique amount or unique domain identifies the likely source
* demo/test flow exposes operation order clearly

### HIGH

A public observer can narrow the source set to a very small group.

Examples:

* candidate set size is small
* root is very fresh
* time gap is short
* fee or expiry is unique
* relayer behavior is concentrated
* recipient behavior is reused or externally linked

### ELEVATED

Several metadata fields narrow the source set, but not enough to identify a
single likely source with available data.

Examples:

* moderate candidate set
* common denomination but unusual timing
* common relayer but unique expiry
* root batch exists but is small
* adapter domain is narrow

### OBSERVED

A signal is present but not enough to classify as high severity with available
data.

Examples:

* relayer is public
* recipient is public
* root is public
* nullifier is public
* fee and expiry are public
* infrastructure layer is unknown

### UNKNOWN

The diagnostic does not have enough data.

Unknown must not be interpreted as safe.

Examples:

* missing snapshot
* missing root history
* missing action slot
* incomplete indexer data
* unknown relayer policy
* unavailable recipient history
* unknown RPC or infrastructure path

## Input Data

A diagnostic report may use public or locally available data.

### Required Inputs for `WITHDRAW_SOL_V1`

* adapter id
* root
* nullifier hash
* tx_hash / intent hash
* withdrawal slot
* denomination
* fee
* expiry slot
* recipient
* relayer
* circuit version
* root submission slot, if available
* snapshot or indexed note tree data, if available

### Optional Inputs

* deposit or commitment event history
* root history
* relayer usage history
* fee distribution
* expiry distribution
* recipient reuse history
* snapshot provenance
* RPC source used for fetching public data
* indexer version
* diagnostic version

### Data That Must Not Be Required

The diagnostic layer should not require:

* note secret
* raw witness
* private nullifier preimage
* private randomness
* local secret files
* private user IP logs
* relayer private logs
* hosted API private logs

Diagnostics should be possible using public chain data and local indexer state
whenever possible.

## Diagnostic Output

A diagnostic report should be machine-readable and human-readable.

Suggested JSON shape:

```json
{
  "diagnostic_version": "0.1.0",
  "adapter_id": "WITHDRAW_SOL_V1",
  "action": {
    "signature": "<optional>",
    "slot": 475000000,
    "root": "<root>",
    "nullifier_hash": "<nullifier_hash>",
    "intent_hash": "<tx_hash>",
    "denomination": "1000000000",
    "fee": "10000000",
    "expiry_slot": 475200000,
    "recipient": "<recipient_pubkey>",
    "relayer": "<relayer_pubkey>",
    "circuit_version": 1
  },
  "input_quality": {
    "snapshot_available": true,
    "root_history_available": true,
    "commitment_history_available": true,
    "relayer_history_available": false,
    "recipient_history_available": false
  },
  "signals": {
    "candidate_count": 3,
    "root_age_slots": 412,
    "root_batch_size": 1,
    "same_denomination_count": 3,
    "recent_commitment_count": 1,
    "fee_pattern": "standard",
    "expiry_pattern": "unique",
    "relayer_pattern": "unknown",
    "recipient_pattern": "unknown"
  },
  "finding": {
    "level": "HIGH",
    "reasons": [
      "small candidate set",
      "fresh root",
      "single recent commitment",
      "unique expiry pattern"
    ]
  },
  "limitations": [
    "Recipient history was not available.",
    "Relayer-side request metadata is outside the diagnostic scope.",
    "This report is not a privacy proof."
  ]
}
```

## Candidate Set Computation

For `WITHDRAW_SOL_V1`, the first diagnostic approximation is candidate count.

A candidate commitment is any commitment that could plausibly have produced the
withdrawal under the visible public constraints.

A simple v0 model:

```text
candidate_set_v0 =
  commitments included in the accepted root
∩ commitments compatible with the root domain used by WITHDRAW_SOL_V1
∩ commitments compatible with denomination
∩ commitments created before or at the accepted root
∩ commitments not known to be excluded by public timing constraints
```

The diagnostic should report the size of this set.

It should also report why the set is narrow.

Candidate count is an approximation over public or indexed data. It does not
identify the real source note and must not require private witness material.

Candidate count is not an exact live-unspent-note count. Public nullifiers show
that notes were consumed, but they do not reveal which commitments were
consumed. A v0 diagnostic should therefore treat candidate count as a
conservative public compatibility estimate, not as a precise remaining-note set.

Examples:

```text
candidate_count = 1
reason = only one compatible commitment existed under the accepted root
```

```text
candidate_count = 3
reason = three compatible commitments existed, but one was added shortly before root submission
```

```text
candidate_count = UNKNOWN
reason = snapshot or commitment history unavailable
```

Candidate count is only a starting point. A larger candidate set can still
become narrow after applying timing, relayer, recipient, fee, expiry, or
infrastructure filters.

## Root Freshness Diagnostic

Root freshness measures how recently the accepted root was produced relative to
the action.

Useful fields:

* root submission slot
* action slot
* root age in slots
* number of commitments added since previous root
* number of compatible commitments in the new batch
* whether the root was created after a single commitment

Example signals:

```text
root_age_slots = action_slot - root_submission_slot
root_batch_size = commitments_in_root - commitments_in_previous_root
compatible_batch_size = compatible_commitments_in_new_batch
```

Finding examples:

* CRITICAL if a root contains only one new compatible commitment and the
  withdrawal follows shortly after
* HIGH if root age is very small and candidate count is small
* ELEVATED if root is fresh but batch size is moderate
* UNKNOWN if root submission slot or previous root state is unavailable

Root freshness should not become a privacy oracle. The diagnostic should warn
conservatively without implying that older roots are automatically safe.

## Timing Diagnostic

Timing compares public events around a ZK action.

Useful fields:

* commitment slot
* root submission slot
* withdrawal or claim slot
* deposit-to-root delay
* root-to-action delay
* commitment-to-action delay

Example findings:

* immediate deposit to withdrawal
* immediate claim commitment to claim
* root submitted immediately after a single commitment
* withdrawal submitted immediately after witness/proof generation in a public
  demo context

Timing is one of the strongest practical linkability surfaces, especially in
small test sets.

The diagnostic should report timing signals without attempting to identify the
user.

## Amount and Denomination Diagnostic

Amounts are strong filters.

For fixed-denomination adapters, the diagnostic should report the size of the
denomination bucket under the accepted root.

Useful fields:

* denomination
* total commitments under root
* compatible commitments for denomination
* number of active denomination buckets
* relative bucket concentration

Example:

```text
total_commitments_under_root = 100
same_denomination_count = 4
```

The effective anonymity set for a 1 SOL withdrawal is closer to 4 than 100.

For future variable-amount adapters, unique or rare amounts should be treated as
high-severity fingerprints unless hidden or bucketed by design.

## Fee Diagnostic

Fees can fingerprint flows.

Useful fields:

* fee value
* fee bucket
* fee distribution among recent actions
* relayer fee policy
* whether the fee is standard, rounded, or unique

Finding examples:

* unique fee value
* relayer-specific fee pattern
* user-specific fee override
* fee tied to external context

A standard fixed fee may reduce fee-based linkability, but it does not solve
other metadata risks.

## Expiry Diagnostic

Expiry values can also fingerprint actions.

Useful fields:

* expiry slot
* action slot
* expiry delta
* expiry bucket
* whether expiry is exact, rounded, or epoch-based
* distribution of expiry deltas among comparable actions

Finding examples:

* unique expiry slot
* unusually short expiry
* unusually long expiry
* expiry generated from a user-specific workflow

A diagnostic should flag unique expiry patterns, especially when candidate count
is small.

## Recipient Diagnostic

For withdrawal-style adapters, recipient is public.

Useful fields:

* recipient address
* whether recipient has appeared before in Cirrus actions
* whether recipient equals relayer
* whether recipient is funded by a known depositor address, if public data is
  available
* whether recipient has public identity links, if externally known

The first diagnostic version should be conservative.

If recipient history is unavailable, report:

```text
recipient_pattern = UNKNOWN
```

Do not infer safety from missing recipient data.

## Relayer Diagnostic

Relayers can reduce direct wallet linkage but introduce their own metadata
surface.

Useful fields:

* relayer address
* relayer reuse count
* relayer share among recent actions
* relayer fee pattern
* recipient/relayer aliasing
* whether one relayer dominates the flow

Finding examples:

* single relayer handles most actions
* same user repeatedly uses same relayer
* relayer fee pattern uniquely identifies a flow
* recipient equals relayer
* relayer has private request logs outside protocol visibility

The diagnostic should distinguish on-chain relayer signals from relayer-side
private metadata.

## Snapshot and Indexer Diagnostic

Snapshots support reproducibility and root provenance.

They can also leak operational context.

Useful fields:

* snapshot version
* root
* slot range
* event count
* leaf count
* RPC source
* commitment level
* indexer version
* whether snapshot includes private or local-only fields

A snapshot diagnostic should check that public artifacts do not include:

* note secrets
* witness data
* local filesystem paths
* operator-only key paths
* private RPC URLs
* private environment variables
* raw private inputs

Snapshot metadata is useful only if it does not become a new privacy leak.

## Infrastructure Diagnostic

Infrastructure metadata is mostly outside on-chain verification.

Potential observers:

* RPC providers
* hosted APIs
* relayers
* indexers
* proof services
* facilitators
* wallets
* analytics providers

Potential signals:

* IP address
* request timing
* simulation timing
* snapshot fetch timing
* proof-generation requests
* transaction submission source
* retry behavior
* wallet integration behavior

The first diagnostic model should not pretend to measure private infrastructure
data. Instead, it should include an explicit limitation:

```text
Infrastructure metadata was not measured by this report.
```

For local-only flows, the diagnostic may record that witness/proof generation
was performed locally, if the tool can establish this without exposing private
data.

## Adapter Diagnostic Schema

Each adapter should define a diagnostic schema before implementation.

Minimum fields:

```text
adapter_id
adapter_type
root_domain
public_inputs_schema
intent_hash_schema
nullifier_policy
required_public_accounts
event_surface
recipient_or_target_surface
relayer_or_facilitator_surface
timing_surface
amount_or_value_surface
claim_domain_surface
infrastructure_assumptions
diagnostic_signals
known_limitations
```

For `WITHDRAW_SOL_V1`:

```text
adapter_id: WITHDRAW_SOL_V1
adapter_type: value_withdrawal
root_domain: value_note_tree
public_inputs: [root, nullifier_hash, tx_hash]
intent_hash: tx_hash
nullifier_policy: one nullifier per spent note
visible_action_surface:
  - root
  - nullifier_hash
  - tx_hash
  - recipient
  - relayer
  - denomination
  - fee
  - expiry
  - circuit_version
diagnostic_signals:
  - candidate_count
  - root_age_slots
  - root_batch_size
  - denomination_bucket_count
  - timing_gap
  - fee_pattern
  - expiry_pattern
  - relayer_pattern
  - recipient_pattern
```

For future claim adapters:

```text
adapter_id: CLAIM_*_V1
adapter_type: private_claim
root_domain: claim_tree or adapter-defined claim root domain
public_inputs: adapter-defined
intent_hash: adapter-specific claim/action digest
nullifier_policy: one nullifier per claim or per claim domain
visible_action_surface:
  - claim domain
  - issuer or resource family, if public
  - nullifier_hash
  - intent_hash
  - action target
  - expiry
diagnostic_signals:
  - claim_domain_size
  - issuer_concentration
  - resource_uniqueness
  - redemption_timing
  - facilitator_pattern
  - external_payment_metadata
```

## Review Gate for New Adapters

Before adding a new adapter, the design should answer:

1. What public metadata does this adapter reveal?
2. Which fields are required for correctness?
3. Which fields are only for indexing or debugging?
4. Which fields narrow the effective anonymity set?
5. What is the adapter’s root domain?
6. What is the adapter’s nullifier scope?
7. What exactly is included in the intent hash?
8. Does the adapter create a small or fragmented anonymity set?
9. Does the adapter depend on external infrastructure metadata?
10. What diagnostics can be computed from public data?

An adapter should not move from concept to implementation until this review
exists.

## Warning vs Blocking

Privacy diagnostics should start as warnings.

In devnet-alpha:

```text
diagnostics = warn only
```

The tool should report finding signals but not prevent experimentation.

In future guarded clients:

```text
diagnostics = strong warning before action
```

The client may warn users when candidate count is small, root is too fresh,
expiry is unique, or relayer concentration is high.

Program-level blocking should be treated carefully. The on-chain program cannot
see enough context to reliably enforce practical privacy, and naive blocking
rules can create new metadata or denial-of-service surfaces.

The safest first path is:

```text
program = correctness enforcement
client/indexer = privacy diagnostics
operator docs = conservative guidance
```

## Diagnostic Versioning

Diagnostic rules should be versioned.

Example:

```text
privacy_diagnostic_version = 0.1.0
```

A diagnostic report should include:

* diagnostic version
* adapter id
* snapshot version
* indexer version
* chain or cluster
* data availability status
* limitations

This avoids treating old reports as if they used the current model.

## Reporting Format

A human-readable report should include:

```text
Summary
Observed finding level
Main reasons
Candidate set information
Root freshness
Timing signals
Action parameter signals
Relayer/recipient signals
Infrastructure limitations
Non-guarantee statement
```

Example human output:

```text
Privacy Diagnostic Report

Adapter: WITHDRAW_SOL_V1
Finding level: HIGH

Main reasons:
- Candidate set is small: 3 compatible commitments.
- Root is fresh: 412 slots old.
- Only one compatible commitment was added in the latest root batch.
- Expiry pattern is unique among observed withdrawals.

Limitations:
- Recipient history was not available.
- Relayer-side request metadata was not measured.
- Infrastructure metadata was not measured.

This report is not a privacy proof.
```

## Possible Implementation Stages

These stages are illustrative. They describe one possible path for turning the
model into tooling, not a commitment to a specific implementation or timeline.

### Stage 1: Documentation

Define the model and adapter review requirements.

Artifacts:

```text
docs/METADATA_LINKABILITY.md
docs/PRIVACY_DIAGNOSTIC_MODEL.md
```

### Stage 2: Manual Diagnostics

Produce manual reports from snapshots and devnet-alpha runs.

No automatic scoring required.

### Stage 3: CLI Diagnostics

A future local CLI could read public snapshot/action data and emit JSON.

For example, a future tool could be named:

```text
scripts/diagnostics/withdraw_zk_metadata_risk.ts
```

Initial inputs might include:

```text
--snapshot <path>
--root <root>
--withdraw-slot <slot>
--denomination <lamports>
--fee <lamports>
--expiry-slot <slot>
--relayer <pubkey>
--recipient <pubkey>
```

Optional later input:

```text
--signature <withdraw_tx_signature>
```

### Stage 4: Devnet Warnings

Integrate diagnostics into devnet-alpha command planners or tester tooling.

The tool should warn before presenting a flow as privacy-relevant.

### Stage 5: Adapter Review Gate

Require each future adapter proposal to include a diagnostic schema before
implementation.

## Current `WITHDRAW_SOL_V1` Diagnostic Priorities

The first diagnostic pass should focus on:

1. candidate count under accepted root
2. root age
3. root batch size
4. denomination bucket size
5. deposit-to-withdraw timing
6. fee pattern
7. expiry pattern
8. relayer reuse
9. recipient/relayer aliasing
10. snapshot safety

These are enough to catch the most obvious devnet-alpha linkability failures
without overbuilding the system.

## Example: Small Test-Set Warning

A devnet-alpha withdrawal may be fully valid:

```text
proof valid
root allowed
nullifier unused
tx_hash bound
withdrawal executed
```

But the diagnostic may still report:

```text
finding_level = CRITICAL
reason = only one compatible commitment existed under the accepted root
```

This is expected.

It means the proof path worked, not that the user had meaningful practical
anonymity.

## Example: Fresh Root Warning

A user deposits a fixed-denomination note.

A new root is submitted immediately.

A withdrawal follows shortly after.

The diagnostic may report:

```text
finding_level = HIGH
reasons:
  - root is fresh
  - latest root batch is small
  - withdrawal occurred shortly after root submission
```

The verifier did its job.

The metadata still narrowed the likely source commitment.

## Example: Unknown Infrastructure Risk

A local report may not know which RPC, relayer, wallet, or hosted API observed
the request.

The diagnostic should report:

```text
infrastructure_metadata = UNKNOWN
```

It should not report:

```text
infrastructure_metadata = SAFE
```

Unknown is not safe.

It is unknown.

## Open Questions

* How should Cirrus choose warning thresholds for candidate count?
* Should thresholds differ between devnet, testnet, and future production
  contexts?
* How should diagnostics represent root freshness without becoming a timing
  oracle?
* Should expiry values be rounded by default?
* Should relayer fees be fixed or bucketed?
* How much recipient history should a local diagnostic attempt to inspect?
* Should diagnostics be deterministic across indexers?
* How should future claim-domain diagnostics avoid leaking additional domain
  metadata?
* What should be the minimum diagnostic schema required for a new adapter
  proposal?

## Summary

A Cirrus action can be valid without being practically private.

The privacy diagnostic model exists to make that distinction explicit.

The first goal is not to solve every metadata problem. The first goal is to
avoid hiding those problems behind a successful ZK proof.

For `WITHDRAW_SOL_V1`, the diagnostic layer should report conservative signals
such as candidate count, root freshness, denomination bucket size, timing, fee
and expiry uniqueness, relayer behavior, recipient behavior, and snapshot
safety.

For future adapters, diagnostics should become a design gate.

Before adding a new action family, Cirrus should ask:

```text
What public metadata does this adapter reveal?
Does that metadata reduce the effective anonymity set?
Can the risk be measured or at least reported?
```

Only then should the adapter move forward.
