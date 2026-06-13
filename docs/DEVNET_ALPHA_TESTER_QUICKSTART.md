# Devnet Alpha Tester Quickstart

> **Network:** Solana devnet — Cirrus Protocol devnet alpha.
> Unaudited, single-operator, no privacy guarantee. Devnet test SOL only.

A short, command-first path for trying the shared devnet-alpha pool. Read
[`docs/TESTER_ONBOARDING.md`](TESTER_ONBOARDING.md) first for the full picture —
what the protocol does and does not provide, the trust model, and known
limitations.

## Before you start

- **Devnet only.** Do not use mainnet funds or real wallet addresses.
- **Keep private files out of commits.** Note files and wallet keypairs must
  stay outside the repository and must never be committed.
- Use the recommended **1 SOL** devnet bucket.
- **Root submission is operator-managed.** Testers do not submit roots.

Placeholders below are not real paths — substitute your own:

| Placeholder | Meaning |
|---|---|
| `<TESTER_KEYPAIR>` | Your devnet wallet keypair, stored outside the repo |
| `<NOTE_OUTPUT_OUTSIDE_REPO>` | Path the deposit writes your note file to, outside the repo |
| `<SNAPSHOT_JSON>` | Operator-provided note-tree snapshot |
| `<ROOT_HEX>` | 64-hex Merkle root |
| `<LEAF_INDEX>` | Your note's leaf index in the tree |
| `<RECIPIENT_PUBKEY>` | Withdrawal recipient (public) |
| `<RELAYER_PUBKEY>` | Relayer (public); must differ from the recipient |

## 1. Check shared-pool status (read-only)

```bash
npm run alpha:status -- --rpc-url https://api.devnet.solana.com --json
```

A healthy shared pool reports:

- `configExists: true`
- `paused: false`
- `rootCapacitySeverity: ok`

This step is read-only: no wallet, no keypairs, no transactions, no root
submission.

## 2. Preview a deposit

```bash
npm run alpha:deposit -- --wallet <TESTER_KEYPAIR> --note-output <NOTE_OUTPUT_OUTSIDE_REPO>
```

Without `--yes` this is a preview: it validates your inputs and explains what
would happen, but signs nothing, sends no transaction, and writes no note file.
Review the planned denomination and addresses before continuing.

## 3. Run the deposit

```bash
npm run alpha:deposit -- --wallet <TESTER_KEYPAIR> --note-output <NOTE_OUTPUT_OUTSIDE_REPO> --yes
```

After a successful deposit:

- **Keep the note file private** and outside the repo — it is what lets you
  withdraw later. There is no operator recovery for a lost note file.
- Share only public coordination info (transaction signature, Merkle root) with
  the operator as needed.
- The operator indexes deposits and submits an allowed root. You do not submit
  roots.

## 4. Wait for root readiness

Once the operator confirms your root is allow-listed, verify it on-chain:

```bash
npm run alpha:status -- --rpc-url https://api.devnet.solana.com --expected-root <ROOT_HEX> --commitment confirmed --json
```

When the expected root is allow-listed and the pool is healthy, the report's
`ready` field is `true`.

## 5. Simulate a withdrawal (no live send)

```bash
npm run alpha:withdraw:simulate -- --note <NOTE_OUTPUT_OUTSIDE_REPO> --snapshot <SNAPSHOT_JSON> --leaf-index <LEAF_INDEX> --root <ROOT_HEX> --recipient <RECIPIENT_PUBKEY> --relayer <RELAYER_PUBKEY>
```

- `--recipient` and `--relayer` must be **distinct** pubkeys.
- This is a read-only preflight: it does **not** broadcast a transaction and
  does **not** consume your nullifier.

## Live withdrawal

The `withdraw_zk` live path has been **proven in a devnet rehearsal** — a real
on-chain spend. In this alpha, the live send remains **operator-assisted** and
lower-level; the guided `alpha:withdraw:simulate` command stops at simulation
and never sends. If you need a live withdrawal, coordinate with the operator.

## Troubleshooting

| Symptom | What it means / what to do |
|---|---|
| **Root not ready** | `ready` is `false`, or your expected root is absent. The operator has not allow-listed it yet — re-run step 4 once they confirm. |
| **Root capacity warning** | `rootCapacitySeverity` is `warning` or `critical`: the allowlist is near or at capacity. This is an operator concern; you can still simulate against an already allow-listed root. |
| **Recipient equals relayer** | The simulate command rejects identical `--recipient` and `--relayer`. Use two distinct pubkeys. |
| **Note file missing** | Keep the file written by `--note-output` safe and outside the repo. Without it you cannot assemble a withdrawal, and the operator cannot recover it for you. |
| **Never commit private files** | Note files and wallet keypairs stay out of every commit. Confirm they are git-ignored or live outside the working tree. |

---

Devnet only, unaudited, no privacy guarantee. Everything here uses test SOL on
Solana devnet — never use real funds or real wallet addresses, and treat no
result as a privacy, audit, or production guarantee.
