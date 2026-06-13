# WITHDRAW_SOL_V1 ZK Fixture Plumbing

This directory holds artifact plumbing files for the `WITHDRAW_SOL_V1` circuit.

## Committed files

| File | Description |
| --- | --- |
| `public_test_vector.json` | Deterministic public-input test vector. **Not a real Groth16 proof.** |
| `artifact_manifest.json` | Placeholder artifact metadata. Populate after real circuit keys are generated. |
| `synthetic_snarkjs_proof_shape.json` | Synthetic encoder shape test vector. **Not a real Groth16 proof.** |
| `synthetic_verification_key_shape.json` | Synthetic snarkjs verification key shape test vector. **Not a real VK.** |
| `synthetic_public_json_shape.json` | Synthetic snarkjs public.json shape fixture. **Not real prover output.** |

## `public_test_vector.json`

- Built from the locked parity vector constants (same values pinned in `tests/zk_tx_hash_parity.ts` and `programs/shielded_pool_anchor/src/zk_hash.rs`).
- `tx_hash_be_hex` is a real Poseidon computation using the real Anchor PDAs and equals the locked parity vector.
- `root_be_hex` and `nullifier_hash_be_hex` are real values from the canonical Groth16 proof (TEST_SECRET=12345, leaf_index=0).
- `pool_pda` and `config_pda` are the real Anchor PDAs derived from program seeds under program ID `E593efjkVU3Z6pJQtSLf7jECFeGBVy2UQZwET4nqLhyq`.
- Validated by `tests/zk_real_fixture_shape.ts`.

## `artifact_manifest.json`

- All hash fields are `null` until real circuit artifacts (proving key, verifying key, compiled circuit) are generated.
- `status` is `"placeholder"`. The fixture shape test asserts this; it will fail when real artifacts land, prompting the engineer to update the manifest explicitly.

## Git-ignored files in this directory

The following files are ignored and must never be committed:

- `*.zkey` — snarkjs proving keys (may be hundreds of MB)
- `*.r1cs` — compiled circuit constraint systems
- `*.wtns` — snarkjs native witness format
- `proof.json` — locally generated real proof output
- `witness.json` — full witness export (may contain derived private data)
- `witness_export.json` — local witness export copy
- `verification_key.json` — real verifying key bytes

### Artifact descriptions and sensitivity levels

**`proof.json`** — snarkjs Groth16 proof output. Must remain git-ignored until an explicit decision is made to commit a sanitized canonical fixture. If committed in a future PR, it must be generated from the deterministic test vector, reviewed before inclusion, and accompanied by a hash recorded in `artifact_manifest.json`.

**`public.json`** — public input array `[root, nullifier_hash, tx_hash]` from the snarkjs/prover flow. Not pattern-git-ignored, but must not be committed unless it contains only non-private values from a deterministic test vector with zero-placeholder or known inputs. Must match the locked public input order.

**`verification_key.json`** — real snarkjs VK JSON. Git-ignored because it contains the verifying key material. A future PR must decide: commit a sanitized VK JSON, commit only a derived Rust constant, or record only the hash. See §5.B of `docs/PHASE4_STATUS_AND_GROTH16_CHECKLIST.md`.

**`*.zkey`** — proving key. Likely hundreds of MB to several GB. Contains sensitive proving material. Must remain git-ignored unconditionally. Store separately from the repo (e.g., secure operator storage). Record only its SHA-256 hash in `artifact_manifest.json`.

**`*.r1cs`** — compiled circuit constraint system. May be large. Must remain git-ignored unless explicitly approved and documented in a reviewed PR.

**`*.wtns`** — snarkjs native witness file. May contain derived witness values. Must remain git-ignored.

**`witness.json` / `witness_export.json`** — witness export bundles produced by `scripts/zk_prover_export_witness.ts`. The raw note secret is not present (see `docs/PHASE4_WITNESS_EXPORT.md`), but derived values are. Must remain git-ignored.

## Synthetic proof shape fixture

`synthetic_snarkjs_proof_shape.json` is only for encoder shape tests. It contains small synthetic decimal coordinates that are not guaranteed to be on-curve and have no cryptographic meaning.

It is intentionally distinct from `proof.json`, which is the real snarkjs proof output filename and remains git-ignored.

The synthetic fixture pins the expected `proof_b` byte layout used by `lib/zk_prover/proof_encoder.ts`.

## Synthetic verification key shape fixture

`synthetic_verification_key_shape.json` is only for VK parser shape tests. It contains small synthetic decimal coordinates that are not guaranteed to be on-curve and have no cryptographic meaning.

It is intentionally distinct from `verification_key.json`, which is the real snarkjs VK output filename and remains git-ignored.

The synthetic fixture pins the expected `Groth16Verifyingkey` byte layout used by future `zk_vk_withdraw_sol_v1.rs` generation:

- G1: `x_BE || y_BE` (no y-negation — VK G1 points are not negated)
- G2: `x.c1_BE || x.c0_BE || y.c1_BE || y.c0_BE` (same layout as `proof_b`)
- IC length: `4 = 3 public inputs + 1 constant term`
- crate field typo: `vk_gamme_g2` (not `vk_gamma_g2`)

## Synthetic public input shape fixture

`synthetic_public_json_shape.json` is only for public input normalization tests. It mimics snarkjs `public.json` decimal-string output for the deterministic public test vector.

It pins the expected public input order:

- `public[0] = root`
- `public[1] = nullifier_hash`
- `public[2] = tx_hash`

The fixture is not real prover output and does not prove circuit validity.

## Future artifact generation procedure

For the full preflight checklist before generating real artifacts, see
[`docs/PHASE4_REAL_ARTIFACT_PREFLIGHT_RUNBOOK.md`](../../../../docs/PHASE4_REAL_ARTIFACT_PREFLIGHT_RUNBOOK.md).

Real artifacts should not be generated from an unfrozen or unidentified circuit source. The circuit source reference and SHA-256 hash should be recorded before updating `artifact_manifest.json`.

This is the planned generation flow for WITHDRAW_SOL_V1 real proof artifacts.
**None of these steps should be run from this PR.** Exact commands must be verified against the final circuit and prover toolchain before use.

```bash
# Template only — do not run in this PR.
# Verify all commands against the actual toolchain before executing.

# 1. Compile circuit to r1cs + wasm
# circom WITHDRAW_SOL_V1.circom --r1cs --wasm --sym -o build/

# 2. Generate or reuse a powers-of-tau file for the circuit constraint size
# snarkjs powersoftau new bn128 <power> pot_<power>_final.ptau
#   (or reuse an existing trusted ptau file of sufficient size)

# 3. Generate initial zkey (phase 2 setup)
# snarkjs groth16 setup WITHDRAW_SOL_V1.r1cs pot_<power>_final.ptau \
#   WITHDRAW_SOL_V1_0000.zkey

# 4. Contribute to phase 2 ceremony (minimum one contribution for test keys)
# snarkjs zkey contribute WITHDRAW_SOL_V1_0000.zkey WITHDRAW_SOL_V1_final.zkey \
#   --name="<contributor>" -e="<entropy>"

# 5. Export verification key
# snarkjs zkey export verificationkey WITHDRAW_SOL_V1_final.zkey \
#   tests/fixtures/zk/withdraw_sol_v1/verification_key.json

# 6. Generate canonical witness for the deterministic test vector
# node build/WITHDRAW_SOL_V1_js/generate_witness.js \
#   build/WITHDRAW_SOL_V1_js/WITHDRAW_SOL_V1.wasm \
#   <input.json> \
#   tests/fixtures/zk/withdraw_sol_v1/witness.wtns

# 7. Generate canonical proof
# snarkjs groth16 prove \
#   WITHDRAW_SOL_V1_final.zkey \
#   tests/fixtures/zk/withdraw_sol_v1/witness.wtns \
#   tests/fixtures/zk/withdraw_sol_v1/proof.json \
#   tests/fixtures/zk/withdraw_sol_v1/public.json

# 8. Verify proof locally before proceeding
# snarkjs groth16 verify \
#   tests/fixtures/zk/withdraw_sol_v1/verification_key.json \
#   tests/fixtures/zk/withdraw_sol_v1/public.json \
#   tests/fixtures/zk/withdraw_sol_v1/proof.json

# 9. Confirm public.json matches the locked public input order [root, nullifier_hash, tx_hash]
# (Manual inspection — compare against public_test_vector.json params)

# 10. Encode proof using proof_encoder.ts
# npx ts-node -e "
#   const {loadAndEncodeSnarkjsGroth16Proof} = require('./lib/zk_prover/proof_encoder');
#   console.log(JSON.stringify(
#     loadAndEncodeSnarkjsGroth16Proof('tests/fixtures/zk/withdraw_sol_v1/proof.json'),
#     null, 2));
# "

# 11. Hash all artifacts for artifact_manifest.json
# sha256sum \
#   WITHDRAW_SOL_V1_final.zkey \
#   tests/fixtures/zk/withdraw_sol_v1/verification_key.json \
#   tests/fixtures/zk/withdraw_sol_v1/proof.json \
#   <r1cs_path>
```

Do not commit `*.zkey`, `*.r1cs`, `*.wtns`, `witness.json`, or `witness_export.json`. Commit only sanitized, reviewed artifact metadata and hashes in `artifact_manifest.json`.

## Manifest update policy

`artifact_manifest.json` must be updated from `status: "placeholder"` to `status: "real"` only in the same PR that:

- Produces or links to verified real artifact hashes.
- Confirms `proof_encoder.ts` output against real `proof.json`.
- Records hashes for all generated files (circuit, proving key, VK, proof fixture).

When `status` is `"real"`, all of the following fields must be non-null:

| Field | Description |
| --- | --- |
| `circuit_hash_sha256` | SHA-256 of the compiled `.r1cs` file |
| `proving_key_hash_sha256` | SHA-256 of the final `.zkey` file |
| `verification_key_hash_sha256` | SHA-256 of `verification_key.json` |
| `canonical_proof_fixture_hash_sha256` | SHA-256 of the canonical `proof.json` or its encoded byte representation |
| `generated_at` | ISO 8601 timestamp of artifact generation |
| `generator_tool` | Tool and version string (e.g., `snarkjs@0.7.x + circom@2.x.x`) |

If an artifact is not committed (e.g., `.zkey` is too large), its SHA-256 hash must still be recorded in the manifest alongside a location note.

**The `tests/zk_real_fixture_shape.ts` suite will fail when `status` is no longer `"placeholder"`.** This is intentional — it prompts explicit, reviewed update of the manifest rather than silent drift.

## `chain_id` note

`chain_id` in `public_test_vector.json` is `"1"`. This must match `config.chain_id` in any on-chain deployment this fixture is used with. The devnet alpha uses `chain_id = 1`.

## When real circuit artifacts are ready

1. Generate proving key and verifying key.
2. Compute `sha256` of each artifact file.
3. Populate the hash fields in `artifact_manifest.json` and set `status` to `"real"`.
4. Update `tests/zk_real_fixture_shape.ts` to remove the `status === "placeholder"` assertion and add artifact hash pinning.
5. See `docs/PHASE4_STATUS_AND_GROTH16_CHECKLIST.md` §5-B for the VK strategy decision (binary-embedded vs. `VkRegistry` PDA).
