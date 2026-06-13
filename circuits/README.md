# circuits/

This directory contains the circuit source for `WITHDRAW_SOL_V1`.

## Contents

- `WITHDRAW_SOL_V1.circom` — circuit source for the first private SOL withdrawal proof

## Source-only

This directory contains `.circom` source only. No compiled artifacts are committed here.

The following files must never be committed to this repo:

| File pattern | Why excluded |
| --- | --- |
| `*.r1cs` | compiled constraint system |
| `*.wasm` | witness generator binary |
| `*.zkey` / `*.ptau` | proving key (large; potentially private) |
| `*.wtns` | witness (private prover input) |
| `*_js/` | circom JS witness generation directory |
| `verification_key.json` | verifying key (committed only in a separate reviewed PR) |
| `proof.json` | proof output (not committed until reviewed) |
| `public.json` | public inputs output (not committed until reviewed) |

All of these patterns are covered by the root `.gitignore`. Run `git check-ignore <path>` before staging anything from a circuit build.

## Public input order

The public input order is locked. It must not change without regenerating all artifacts and updating the on-chain verifier.

| `public.json` index | Groth16 IC index | Signal |
| --- | --- | --- |
| 0 | IC[1] | `root` |
| 1 | IC[2] | `nullifier_hash` |
| 2 | IC[3] | `tx_hash` |

IC[0] is the Groth16 constant term.

`nPublic = 3`, `IC.length = 4`.

## Hash parameters

- Poseidon BN254 x5, circomlib-compatible
- Must produce byte-identical output to circomlibjs 0.1.7 for the same inputs
- Parity is confirmed by `tests/zk_tx_hash_parity.ts` and `programs/.../src/zk_hash.rs` unit tests

## Before artifact generation

Do not compile this circuit or generate proving artifacts until all of the following are true:

- [ ] This source has been reviewed against the locked TS/Rust hash formulas
- [ ] `nPublic = 3` confirmed in `snarkjs r1cs info` output
- [ ] `IC.length = 4` confirmed in `vk_parser.ts` output after VK export
- [ ] Poseidon parameterization matches circomlibjs 0.1.7 for all used arities
- [ ] Pubkey lo/hi split convention (LE u128) confirmed against `witness.ts::splitPubkey`
- [ ] Circuit source is frozen — no further changes expected for this artifact pass
- [ ] SHA-256 of this file recorded (store in `tests/fixtures/zk/withdraw_sol_v1/artifact_manifest.json` `notes` field)
- [ ] `circom` version recorded
- [ ] `snarkjs` version recorded
- [ ] ptau file source and size confirmed for the constraint count

See `docs/PHASE4_REAL_ARTIFACT_PREFLIGHT_RUNBOOK.md` for the full artifact generation procedure.

## Circuit source hash

Before running any artifact generation command, record:

```bash
sha256sum circuits/WITHDRAW_SOL_V1.circom
```

Store the result in the `notes` field of `tests/fixtures/zk/withdraw_sol_v1/artifact_manifest.json`. This ties any future artifact set back to the exact circuit version that produced it.

## Witness dry run

```bash
npm run zk:witness-dry-run
```

Compiles `WITHDRAW_SOL_V1` to `/tmp`, builds a deterministic dummy input using the existing witness helpers, runs `generate_witness.js`, and checks the result with `snarkjs wtns check`. Does not run trusted setup, generate a proof, export a VK, or write any artifact into the repo.
