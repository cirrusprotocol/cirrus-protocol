# ZK Artifact Dependency Manifest

> **Devnet-alpha only. Unaudited. Not for real funds.**
>
> This document is an artifact manifest and operator reference, not a security audit.
> Having these artifacts does not prove privacy, production readiness, or correct setup.
> All claims describe the current devnet-alpha state.

---

## Required artifacts for the real-proof withdraw_zk path

The `withdraw_zk` path (`scripts/ops/withdraw_zk_devnet.ts`) requires several ZK artifacts
that are not committed to this repository. Obtain or generate them externally and keep them
outside the repo directory.

| Artifact | Purpose | Committed? | Simulate? | Send? | Notes |
|---|---|---|---|---|---|
| Circuit `.wasm` | Witness generation | No | Yes | Yes | Must match the `.zkey`; generated from `circuits/WITHDRAW_SOL_V1.circom` via `circom` |
| Proving key `.zkey` | Groth16 proof generation | No | Yes | Yes | Must match the circuit and verification key; operator-controlled |
| `verification_key.json` | Public verifier key metadata | No | No | No | Hash recorded in `tests/fixtures/zk/withdraw_sol_v1/artifact_manifest.json`; not committed |
| `proof.json` | Generated Groth16 proof output | No | Yes | Yes | Runtime artifact; passed via `--proof-json`; never commit |
| `public.json` | Public inputs (`root`, `nullifier_hash`, `tx_hash`) | No | Yes | Yes | Runtime artifact; passed via `--public-json`; never commit |
| Circuit input JSON | circom-compatible input for witness generation | No | Yes | Yes | Written by `zk_prover_export_witness.ts --circuit-input-output`; never commit |
| `witness.json` | Witness prover-input bundle | No | Yes | Yes | Contains private proof inputs; passed via `--witness-output`; never commit |
| Snapshot JSON | Local Merkle tree snapshot | No | Yes | Yes | Runtime/test artifact; verify provenance before use; never commit |
| Secret file | Note secret input (hex) | No | Yes | Yes | Never commit; avoid shell history; use `--secret-file` |

Many expected artifact paths are covered by `.gitignore`, but operators must still verify
with `git check-ignore <path>` before staging any generated artifact or secret.

### How testers obtain artifacts

For controlled devnet-alpha testing, the operator provides the current circuit `.wasm`
and proving key `.zkey` artifacts out-of-band to authorized testers. Alternatively, the
tester can reproduce them from the circuit source using the toolchain and provenance path
documented in `## Toolchain` and `## Provenance` below.

These files are intentionally not committed to the repository. Do not add them to git.
Verify any received artifact against the hashes recorded in
`tests/fixtures/zk/withdraw_sol_v1/artifact_manifest.json` before relying on it.

Before proof generation, testers/operators should verify their local `.wasm`/`.zkey`
artifacts against `artifact_manifest.json` using `scripts/ops/verify_zk_artifacts.ts`
(read-only; no network, no keypairs). This only verifies hash/provenance consistency;
it is not an audit and does not make the trusted setup multi-party. Note: the current
manifest records a proving-key and verification-key hash but **no `.wasm` hash**, so the
`.zkey` and verification key can be checked today while the `.wasm` cannot be verified
until a wasm hash is recorded — the tool fails on an unrecorded artifact by default, and
`--allow-unverified` only downgrades it to a clearly-reported `UNVERIFIED` status.

For devnet-alpha operator-created notes, use `scripts/ops/generate_note_secret.ts` to
create a note secret and deposit commitment. The secret must never be committed or shared
and is required later for witness export.

### Public inputs order

The public input order for `WITHDRAW_SOL_V1` is locked:

| `public.json` index | Signal |
|---|---|
| 0 | `root` |
| 1 | `nullifier_hash` |
| 2 | `tx_hash` |

`nPublic = 3`. Do not reorder without regenerating all artifacts and updating the on-chain
verifier.

---

## Toolchain

The following versions were used for the current devnet-alpha artifact set:

| Tool | Version used | Notes |
|---|---|---|
| `circom` | 2.1.6 | Circuit compiler |
| `snarkjs` | 0.7.4 | Proof generation and VK export |
| `circomlib` | 2.0.5 | Circuit library (Poseidon hash primitives) |
| `circomlibjs` | 0.1.7 | JS Poseidon; must produce byte-identical output to the circuit |
| Node.js | 20+ | Runtime for witness export and proof scripts |

`snarkjs` is not listed in the root `package.json`. It must be installed separately or
used from a global installation when running proof generation outside the repository.

The `circomlibjs` version matters: the circuit and on-chain verifier depend on byte-identical
Poseidon BN254 x5 output. Mismatched versions produce invalid proofs that fail on-chain
verification with no obvious error.

---

## Provenance

The current devnet-alpha artifact set is recorded in
`tests/fixtures/zk/withdraw_sol_v1/artifact_manifest.json`. Key fields:

| Field | Value |
|---|---|
| `circuit_source_hash_sha256` | `e8933a4f92244520ffac29e2772ebdcc5bc428adaa60045470917372ae776e04` |
| `ptau_source_url` | `https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_13.ptau` |
| `ptau_hash_sha256` | `95751b5207f20aa822f01109902315c01c15250303feacea2b8aa7dc9fdfeefd` |
| `proving_key_hash_sha256` | `204ef02fce3e5bb9f5d9b07c06bd4da550d6caefc4842ba508d0aafef4e49bbe` |
| `verification_key_hash_sha256` | `2f13a8318ad49fdca7abc0e475b2d17b090d8eecdf69a483266d9c08f9197b84` |
| `generator_tool` | `circom@2.1.6 + snarkjs@0.7.4 + circomlib@2.0.5` |
| `generated_at` | `2026-06-05T06:54:58Z` |
| `audit_status` | `not-audited` |

### Phase 2 setup

A single local Phase 2 contribution was made with 32 bytes from `/dev/urandom`. The entropy
was not printed, stored, or retained. The `.zkey` is operator-controlled and kept outside
the repository.

This is not a ceremony with multiple independent parties. It is a single-operator devnet
setup. Do not treat the proving key as having multi-party trusted setup security.

### What is not committed

The following are intentionally not committed or publicly distributed:

- The `.zkey` proving key file
- `verification_key.json` (only the hash is recorded in `artifact_manifest.json`)
- Any proof artifacts, witness files, or public input files
- The ptau file itself (only the hash is recorded)

---

## Artifact handling rules

- Never commit keypairs (`keys/*.json`), note secrets, or any file matching `keys/`.
- Never commit witness files (`witness.json`, `*.wtns`).
- Never commit proof outputs (`proof.json`, `public.json`).
- Never commit circuit input JSON, snapshot JSON, or `/tmp` outputs unless explicitly
  reviewed and sanitized.
- Avoid placing secrets in shell history. Use `--secret-file` where available.
- Store generated proof/witness artifacts at paths outside the repository unless the path
  is already covered by `.gitignore`. Verify with `git check-ignore` before staging
  anything.
- Run `git status --short` and `git diff --name-only --cached` before every commit.

The root `.gitignore` already covers: `*.zkey`, `*.r1cs`, `*.wtns`, `*.wasm`, `*.ptau`,
`*.sym`, `circuits/build/`, `circuits/*_js/`, `keys/`, `snapshots/`, and per-fixture
patterns under `tests/fixtures/zk/**/`.

---

## Simulate-only path

For artifact validation without a live send:

1. Obtain or generate a local snapshot and confirm the expected root is in `allowed_roots`.
2. Save the note secret to a file outside the repository.
3. Export the circuit witness:
   ```
   npx ts-node scripts/zk_prover_export_witness.ts --snapshot ... --secret-file ... --yes
   ```
4. Generate the Groth16 proof outside the repository using the `.wasm` and `.zkey` artifacts:
   ```
   snarkjs groth16 fullprove <circuit_input.json> <circuit.wasm> <circuit.zkey> proof.json public.json
   ```
5. Run simulate:
   ```
   npx ts-node scripts/ops/withdraw_zk_devnet.ts --simulate --rpc https://api.devnet.solana.com ...
   ```
6. Confirm `simulationOk: true` before any further steps.

See `docs/DEVNET_ALPHA_RUNBOOK.md` §2.9–§2.10 for the full documented procedure with all
flags, expected output, and hygiene checks.

---

## Send path warning

Live send (`--send`) is not required for artifact validation:

- `--simulate` is a read-only RPC dry-run: no signing, no broadcast, no nullifier consumed.
- `--send` permanently marks the nullifier on-chain. The note cannot be reused.
- Run `--simulate` and confirm `simulationOk: true` before proceeding to `--send`.
- Run manual diagnostics (allowed-roots check, snapshot hygiene) before any live send.
- This is devnet-alpha only. Not for real funds.

---

## Public release gap

Before a clean public release, the following gaps should be addressed:

- **Proving key provenance:** the current setup uses a single local Phase 2 contribution.
  A multi-party ceremony would be needed for production.
- **Pinned toolchain:** `snarkjs` is not in the root `package.json`; it must be pinned and
  documented for reproducibility.
- **Verification key distribution:** the current verification key hash is recorded in
  `artifact_manifest.json` but the key itself is not distributed with the repository.
- **Audited artifacts:** proving and verification key files have not been independently
  reviewed.
- **Reproduction instructions:** end-to-end artifact regeneration from circuit source to
  on-chain verifier has not been publicly documented or independently reproduced.

These are gaps relative to a public release standard, not bugs in the current devnet-alpha.
The current artifact set is appropriate for controlled single-operator devnet testing.
