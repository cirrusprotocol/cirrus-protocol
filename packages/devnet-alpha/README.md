# @cirrusprotocol/devnet-alpha

> **Version:** `0.1.0-alpha.0` — alpha scaffold. **Not published to npm yet.**
> Devnet only. Unaudited. Not for real funds. No privacy guarantee.

A guided devnet-alpha command **planner** (scaffold), not a live runner. It is the
prototype entry point for a future command:

```
devnet-alpha run
```

## Commands

- `run` — guided devnet-alpha entrypoint for the shared **Cirrus devnet alpha pool**
  (`run --help` shows the shared pool profile and constants).
- `plan` — lower-level command planner for the simulate-only `withdraw_zk` flow.

### How `run` behaves

- `devnet-alpha run --help` — prints help.
- `devnet-alpha run` — prints safe instructions (no devnet action).
- `devnet-alpha run --dry-run ...` — **from a repository checkout**, forwards the
  arguments after `run` to the in-repo guided planner (`scripts/ops/devnet_alpha_plan.ts`)
  using the repo's own ts-node setup.

If no repository checkout is detected, `run` prints a clear error and exits non-zero;
standalone (no-checkout) operation is not supported yet. Before forwarding anything, the
wrapper **refuses any live-action argument** (the live-withdrawal flag, `--yes`, or the
deposit / root-submission scripts) so it can never become a live-mutation tool in this
scaffold. The wrapper itself performs no on-chain action, reads no keypairs, and prints
no secrets.

## Shared devnet alpha pool

By default, testers are guided toward one shared Cirrus devnet alpha pool — a single
program deployment, pool, note tree, and root allowlist with one recommended bucket
(1 SOL) — rather than each creating isolated local pools. Sharing one pool improves the
shared test set compared with isolated local pools. This is mechanical devnet testing
only; the shape is Tornado-like, but it is **not** Tornado-level privacy and makes **no
privacy guarantee**. In the current devnet alpha withdrawal flow the recipient, relayer,
and amount are still visible.

The shared profile (`cirrus-devnet-alpha`) ships only public devnet addresses and
constants. It contains no keypairs, no operator material, and no secrets.

It does **not**:

- submit roots (root submission stays operator-managed),
- run live withdrawals,
- read keypair contents,
- print secrets.

## Status

This is an alpha scaffold and is **not published**. `run` does not perform devnet
actions itself — it forwards to the in-repo guided planner, which is where the real
logic lives:

```
scripts/ops/devnet_alpha_plan.ts
```

Run from a checkout of the repository. A future release of this package will wrap it more
fully. See `docs/TESTER_ONBOARDING.md` for the simulate-only flow and caveats.
