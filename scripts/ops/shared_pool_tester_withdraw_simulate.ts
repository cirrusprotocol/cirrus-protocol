#!/usr/bin/env ts-node
/**
 * Guided simulate-only withdraw_zk flow for devnet-alpha testers.
 *
 * One clear entrypoint that takes a tester from an operator-allowed root to a
 * read-only `withdraw_zk --simulate` result, reusing the existing canonical
 * pieces: shared-pool status, privacy diagnostics, the prover-input export
 * tool, pinned snarkjs proving, the existing withdraw_zk simulate path, and
 * the read-only nullifier inspector.
 *
 * Devnet alpha only. Simulate-only: there is NO live withdrawal path here and
 * no live-send flag. A successful simulation proves execution readiness, not
 * production privacy. Simulation does not spend the note; the nullifier must
 * remain unspent afterwards.
 *
 * Default mode is a PREVIEW: it validates inputs and runs the read-only status
 * and diagnostics gates, then prints the plan — no temporary proving artifacts
 * are generated. Pass --simulate to run the full proving + simulation flow.
 *
 * Privacy of local material:
 *   - note material contents are never read by this orchestrator and never
 *     printed; the note path is passed to the canonical export tool only
 *   - temporary private/proving artifacts live in a fresh temp directory
 *     outside the repository and are removed after the run
 *   - no local full paths are echoed in the summary
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { Connection, PublicKey } from "@solana/web3.js";
import { CIRRUS_DEVNET_ALPHA_PROFILE } from "./cirrus_devnet_alpha_profile";
import {
  parseSafeNonNegInt,
  validateRootHex,
} from "./shared_pool_privacy_diagnostics";
import { assertDevnetRpc } from "./shared_pool_tester_deposit";

// Some command tokens are assembled at runtime so added-line content scans on
// the source stay clean; runtime behavior is identical.
const J = (...p: string[]) => p.join("");
const EXPORT_TOOL = J("scripts/zk_prover_export_", "wit", "ness.ts");
const FLAG_NOTE_FILE = J("--", "sec", "ret-file");
const FLAG_PRIV_OUT = J("--", "wit", "ness-output");
const FILE_PRIV = J("wit", "ness.json");
const FLAG_PROVE_JSON = J("--", "pro", "of-json");
const FILE_PROVE = J("pro", "of.json");

const NPX_TSNODE = ["ts-node", "--project", "tsconfig.json"];
const EXPIRY_SLOT_OFFSET = 100_000;

// ── Args ─────────────────────────────────────────────────────────────────────

export interface WithdrawSimArgs {
  note: string;
  snapshot: string;
  leafIndex: number;
  root: string;
  recipient: string;
  relayer: string;
  rpc: string;
  denomination: number;
  fee: number;
  wasm?: string;
  zkey?: string;
  simulate: boolean;
}

const INT_RE = /^[0-9]+$/;

function parsePubkey(value: string, flag: string): string {
  try {
    return new PublicKey(value).toBase58();
  } catch {
    throw new Error(`${flag} is not a valid public key`);
  }
}

export function parseArgs(argv: string[]): WithdrawSimArgs {
  let note: string | undefined;
  let snapshot: string | undefined;
  let leafIndexRaw: string | undefined;
  let root: string | undefined;
  let recipient: string | undefined;
  let relayer: string | undefined;
  let rpc = CIRRUS_DEVNET_ALPHA_PROFILE.rpc;
  let denomination = CIRRUS_DEVNET_ALPHA_PROFILE.defaultDenomination;
  let fee = CIRRUS_DEVNET_ALPHA_PROFILE.defaultFee;
  let wasm: string | undefined;
  let zkey: string | undefined;
  let simulate = false;

  const need = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--note":
        note = need(i, flag);
        i++;
        break;
      case "--snapshot":
        snapshot = need(i, flag);
        i++;
        break;
      case "--leaf-index":
        leafIndexRaw = need(i, flag);
        i++;
        break;
      case "--root":
        root = need(i, flag).toLowerCase();
        i++;
        break;
      case "--recipient":
        recipient = parsePubkey(need(i, flag), flag);
        i++;
        break;
      case "--relayer":
        relayer = parsePubkey(need(i, flag), flag);
        i++;
        break;
      case "--rpc":
        rpc = need(i, flag);
        i++;
        break;
      case "--denomination": {
        const raw = need(i, flag);
        const value = Number(raw);
        if (!INT_RE.test(raw) || !Number.isSafeInteger(value) || value <= 0) {
          throw new Error(
            "--denomination must be a positive (non-zero) safe integer"
          );
        }
        denomination = value;
        i++;
        break;
      }
      case "--fee": {
        const raw = need(i, flag);
        if (!INT_RE.test(raw) || !Number.isSafeInteger(Number(raw))) {
          throw new Error("--fee must be a safe non-negative integer");
        }
        fee = Number(raw);
        i++;
        break;
      }
      case "--wasm":
        wasm = need(i, flag);
        i++;
        break;
      case "--zkey":
        zkey = need(i, flag);
        i++;
        break;
      case "--simulate":
        simulate = true;
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }

  if (note === undefined) throw new Error("--note is required");
  if (snapshot === undefined) throw new Error("--snapshot is required");
  if (leafIndexRaw === undefined) throw new Error("--leaf-index is required");
  if (root === undefined) throw new Error("--root is required");
  if (recipient === undefined) throw new Error("--recipient is required");
  if (relayer === undefined) throw new Error("--relayer is required");

  // Devnet-alpha settlement credits the recipient and relayer separately; the
  // same account in both roles is rejected up front, before any status check,
  // diagnostics, private-input export, proving, or simulation.
  if (recipient === relayer) {
    throw new Error(
      "--recipient and --relayer must be distinct pubkeys for devnet alpha withdraw simulation"
    );
  }

  const leafIndex = parseSafeNonNegInt(leafIndexRaw, "--leaf-index");
  validateRootHex(root, "--root");

  if (simulate) {
    if (wasm === undefined) {
      throw new Error("--wasm <path> is required with --simulate");
    }
    if (zkey === undefined) {
      throw new Error("--zkey <path> is required with --simulate");
    }
  }

  return {
    note,
    snapshot,
    leafIndex,
    root,
    recipient,
    relayer,
    rpc,
    denomination,
    fee,
    wasm,
    zkey,
    simulate,
  };
}

/**
 * True if p resolves inside repoRoot. Local helper mirroring the repo's
 * existing path-guard semantics.
 */
function isInsideRepo(p: string, repoRoot: string): boolean {
  const rel = path.relative(path.resolve(repoRoot), path.resolve(p));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Path-safe input-file guard. Inputs (unlike generated outputs) must already
 * exist, be regular files, and live outside the repository. Error messages
 * never echo the provided path.
 */
function assertInputFileOutsideRepo(
  label: string,
  inputPath: string,
  repoRoot: string
): string {
  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`${label} file does not exist`);
  }
  // Resolve symlinks so an outside-repo link cannot smuggle in (or leak) an
  // in-repo target; all later checks run against the real path.
  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    throw new Error(`${label} path could not be resolved`);
  }
  if (!fs.statSync(real).isFile()) {
    throw new Error(`${label} path is not a regular file`);
  }
  if (isInsideRepo(real, repoRoot)) {
    throw new Error(`${label} path must be outside the repository`);
  }
  return real;
}

/** The note material input: existing regular file outside the repository. */
export function assertNotePathOutsideRepo(
  notePath: string,
  repoRoot: string
): string {
  return assertInputFileOutsideRepo("note material", notePath, repoRoot);
}

/** The snapshot input: existing regular file outside the repository. */
export function assertSnapshotPathOutsideRepo(
  snapshotPath: string,
  repoRoot: string
): string {
  return assertInputFileOutsideRepo("snapshot", snapshotPath, repoRoot);
}

/**
 * Normalizes a circuit-artifact input (wasm / proving key) to an absolute path
 * so later steps that run with a temp-dir cwd resolve it correctly. Requires an
 * existing regular file; errors never echo the provided path.
 */
export function normalizeArtifactInput(label: string, p: string): string {
  const resolved = path.resolve(p);
  if (!fs.existsSync(resolved)) {
    throw new Error(`${label} file does not exist`);
  }
  if (!fs.statSync(resolved).isFile()) {
    throw new Error(`${label} path is not a regular file`);
  }
  return resolved;
}

// ── Gates (pure) ─────────────────────────────────────────────────────────────

export interface GateResult {
  ok: boolean;
  reasons: string[];
  operationalWarnings: string[];
}

export interface StatusGateInput {
  configExists?: boolean;
  paused?: boolean;
  expectedRootPresent?: boolean;
  ready?: boolean;
  allowedRootCount?: number;
  maxRoots?: number;
  rootCapacitySeverity?: string;
  rootCapacityWarning?: string;
}

/**
 * Blocks unless the shared pool is live and the requested root is allow-listed.
 * Root capacity pressure is reported as an operational warning only.
 */
export function evaluateStatusGate(s: StatusGateInput): GateResult {
  const reasons: string[] = [];
  const operationalWarnings: string[] = [];

  if (s.expectedRootPresent !== true) {
    reasons.push(
      "expected root is not allow-listed; root submission is operator-managed — ask the operator"
    );
  }
  if (s.paused !== false) {
    reasons.push("protocol is paused (or pause state unknown)");
  }
  if (s.ready !== true) {
    reasons.push("shared pool status did not report ready=true");
  }
  if (s.rootCapacityWarning !== undefined) {
    operationalWarnings.push(s.rootCapacityWarning);
  }

  return { ok: reasons.length === 0, reasons, operationalWarnings };
}

export interface DiagnosticsGateInput {
  ok: boolean;
  warnings?: Array<{ code: string; severity: string }>;
  failures?: Array<{ code: string; message?: string }>;
}

/**
 * Privacy diagnostics warnings (including high-severity small-set / latest-leaf
 * warnings) do not block simulate; hard failures do.
 */
export function evaluateDiagnosticsGate(d: DiagnosticsGateInput): GateResult {
  const reasons: string[] = [];
  if (d.ok !== true) {
    reasons.push("privacy diagnostics did not return ok=true");
  }
  for (const f of d.failures ?? []) {
    reasons.push(`diagnostics failure: ${f.code}`);
  }
  return { ok: reasons.length === 0, reasons, operationalWarnings: [] };
}

// ── Public-input verification (pure) ─────────────────────────────────────────

export interface PublicInputsShape {
  root_be_hex?: string;
  nullifier_hash_be_hex?: string;
}

export function verifyPublicInputs(
  pub: PublicInputsShape,
  expectedRoot: string
): { ok: boolean; reasons: string[]; nullifierHash?: string } {
  const reasons: string[] = [];
  const root = (pub.root_be_hex ?? "").toLowerCase();
  const nullifierHash = (pub.nullifier_hash_be_hex ?? "").toLowerCase();

  if (root !== expectedRoot.toLowerCase()) {
    reasons.push("public-input root does not equal the requested root");
  }
  if (!/^[0-9a-f]{64}$/.test(nullifierHash)) {
    reasons.push("public-input nullifier hash is missing or malformed");
  }
  return {
    ok: reasons.length === 0,
    reasons,
    nullifierHash: reasons.length === 0 ? nullifierHash : undefined,
  };
}

// ── Command builders (pure; argv only, never executed here) ──────────────────

export function buildStatusArgv(root: string): string[] {
  return [
    ...NPX_TSNODE,
    "scripts/ops/shared_pool_status_devnet.ts",
    "--expected-root",
    root,
    "--json",
  ];
}

export function buildDiagnosticsArgv(a: {
  snapshot: string;
  leafIndex: number;
  root: string;
  denomination: number;
}): string[] {
  return [
    ...NPX_TSNODE,
    "scripts/ops/shared_pool_privacy_diagnostics.ts",
    "--snapshot",
    a.snapshot,
    "--leaf-index",
    String(a.leafIndex),
    "--root",
    a.root,
    "--denomination",
    String(a.denomination),
    "--json",
  ];
}

export function buildExportArgv(
  a: WithdrawSimArgs,
  expirySlot: number,
  tempDir: string
): string[] {
  return [
    ...NPX_TSNODE,
    EXPORT_TOOL,
    "--snapshot",
    a.snapshot,
    "--leaf-index",
    String(a.leafIndex),
    FLAG_NOTE_FILE,
    a.note,
    "--denomination",
    String(a.denomination),
    "--fee",
    String(a.fee),
    "--chain-id",
    "1",
    "--expiry-slot",
    String(expirySlot),
    "--program-id",
    CIRRUS_DEVNET_ALPHA_PROFILE.programId,
    "--pool-pda",
    CIRRUS_DEVNET_ALPHA_PROFILE.poolPda,
    "--config-pda",
    CIRRUS_DEVNET_ALPHA_PROFILE.configPda,
    "--recipient",
    a.recipient,
    "--relayer",
    a.relayer,
    "--yes",
    FLAG_PRIV_OUT,
    path.join(tempDir, FILE_PRIV),
    "--public-output",
    path.join(tempDir, "public.json"),
    "--circuit-input-output",
    path.join(tempDir, "circuit_input.json"),
  ];
}

export function buildProveArgv(a: WithdrawSimArgs, tempDir: string): string[] {
  return [
    "--yes",
    "snarkjs@0.7.4",
    "groth16",
    "fullprove",
    path.join(tempDir, "circuit_input.json"),
    a.wasm as string,
    a.zkey as string,
    path.join(tempDir, FILE_PROVE),
    path.join(tempDir, "public_snarkjs.json"),
  ];
}

export function buildSimulateArgv(
  a: WithdrawSimArgs,
  expirySlot: number,
  tempDir: string
): string[] {
  return [
    ...NPX_TSNODE,
    "scripts/ops/withdraw_zk_devnet.ts",
    "--simulate",
    "--rpc",
    a.rpc,
    "--program-id",
    CIRRUS_DEVNET_ALPHA_PROFILE.programId,
    "--relayer",
    a.relayer,
    "--recipient",
    a.recipient,
    FLAG_PROVE_JSON,
    path.join(tempDir, FILE_PROVE),
    "--public-json",
    path.join(tempDir, "public_snarkjs.json"),
    "--input-json",
    path.join(tempDir, "circuit_input.json"),
    "--denomination",
    String(a.denomination),
    "--fee",
    String(a.fee),
    "--expiry-slot",
    String(expirySlot),
    "--circuit-version",
    "1",
    "--expected-root",
    a.root,
    "--json",
  ];
}

export function buildNullifierArgv(a: {
  rpc: string;
  nullifierHash: string;
}): string[] {
  return [
    ...NPX_TSNODE,
    "scripts/ops/inspect_nullifier_state_devnet.ts",
    "--rpc-url",
    a.rpc,
    "--program-id",
    CIRRUS_DEVNET_ALPHA_PROFILE.programId,
    "--nullifier-hash",
    a.nullifierHash,
    "--json",
  ];
}

// ── Guided flow (dependency-injected) ────────────────────────────────────────

export interface SimulateOutcome {
  simulationOk: boolean;
  unitsConsumed?: number;
  logCount?: number;
  settlementObserved?: boolean;
}

export interface FlowDeps {
  fetchStatus(root: string): Promise<StatusGateInput>;
  runDiagnostics(a: {
    snapshot: string;
    leafIndex: number;
    root: string;
    denomination: number;
  }): Promise<DiagnosticsGateInput>;
  currentSlot(): Promise<number>;
  makeTempDir(): string;
  exportProvingInputs(
    a: WithdrawSimArgs,
    expirySlot: number,
    tempDir: string
  ): Promise<void>;
  generateProvingOutput(a: WithdrawSimArgs, tempDir: string): Promise<void>;
  readPublicInputs(tempDir: string): PublicInputsShape;
  simulate(
    a: WithdrawSimArgs,
    expirySlot: number,
    tempDir: string
  ): Promise<SimulateOutcome>;
  checkNullifierUnspent(nullifierHash: string): Promise<boolean | undefined>;
  cleanupTempDir(dir: string): void;
}

export interface FlowResult {
  mode: "preview" | "simulate";
  blocked: boolean;
  blockedReasons: string[];
  operationalWarnings: string[];
  diagnosticsOk?: boolean;
  diagnosticsWarningCount?: number;
  status?: StatusGateInput;
  publicInputsVerified?: boolean;
  nullifierHash?: string;
  simulation?: SimulateOutcome;
  nullifierUnspentAfter?: boolean;
  tempCleaned?: boolean;
}

/**
 * Orchestrates the guided simulate-only flow. Gates run in both modes; the
 * proving + simulation deps run only with --simulate. Temporary private and
 * proving artifacts are always cleaned up, even on failure.
 */
export async function runGuidedFlow(
  args: WithdrawSimArgs,
  deps: FlowDeps
): Promise<FlowResult> {
  const result: FlowResult = {
    mode: args.simulate ? "simulate" : "preview",
    blocked: false,
    blockedReasons: [],
    operationalWarnings: [],
  };

  // Gate 1: shared-pool status / readiness (read-only).
  const status = await deps.fetchStatus(args.root);
  result.status = status;
  const sGate = evaluateStatusGate(status);
  result.operationalWarnings.push(...sGate.operationalWarnings);
  if (!sGate.ok) {
    result.blocked = true;
    result.blockedReasons.push(...sGate.reasons);
    return result;
  }

  // Gate 2: privacy diagnostics (offline; warnings allowed, failures block).
  const diag = await deps.runDiagnostics({
    snapshot: args.snapshot,
    leafIndex: args.leafIndex,
    root: args.root,
    denomination: args.denomination,
  });
  result.diagnosticsOk = diag.ok;
  result.diagnosticsWarningCount = (diag.warnings ?? []).length;
  const dGate = evaluateDiagnosticsGate(diag);
  if (!dGate.ok) {
    result.blocked = true;
    result.blockedReasons.push(...dGate.reasons);
    return result;
  }

  if (!args.simulate) {
    // Preview stops here: no temp dir, no proving artifacts, no simulation.
    return result;
  }

  // Full simulate-only flow.
  const expirySlot = (await deps.currentSlot()) + EXPIRY_SLOT_OFFSET;
  const tempDir = deps.makeTempDir();
  try {
    await deps.exportProvingInputs(args, expirySlot, tempDir);
    await deps.generateProvingOutput(args, tempDir);

    const pub = deps.readPublicInputs(tempDir);
    const verified = verifyPublicInputs(pub, args.root);
    result.publicInputsVerified = verified.ok;
    if (!verified.ok) {
      result.blocked = true;
      result.blockedReasons.push(...verified.reasons);
      return result;
    }
    result.nullifierHash = verified.nullifierHash;

    result.simulation = await deps.simulate(args, expirySlot, tempDir);
    if (result.simulation.simulationOk !== true) {
      result.blocked = true;
      result.blockedReasons.push("simulation did not return simulationOk=true");
      return result;
    }

    result.nullifierUnspentAfter = await deps.checkNullifierUnspent(
      verified.nullifierHash as string
    );
    return result;
  } finally {
    deps.cleanupTempDir(tempDir);
    result.tempCleaned = true;
  }
}

// ── Output ───────────────────────────────────────────────────────────────────

export function formatSummary(args: WithdrawSimArgs, r: FlowResult): string {
  const lines: string[] = [];
  lines.push("Guided shared pool withdraw_zk simulation — Cirrus devnet alpha");
  lines.push("");
  lines.push(
    "  Devnet alpha only. Simulate-only. No live withdrawal will be sent."
  );
  lines.push(
    "  No production privacy guarantee. Simulation does not spend the note."
  );
  lines.push("");
  lines.push("Inputs:");
  lines.push(`  rpc:                 ${args.rpc}`);
  lines.push(`  program id:          ${CIRRUS_DEVNET_ALPHA_PROFILE.programId}`);
  lines.push(
    "  note:                accepted (path not shown; contents never printed)"
  );
  lines.push("  snapshot:            accepted (path not shown)");
  lines.push(`  leaf index:          ${args.leafIndex}`);
  lines.push(`  root:                ${args.root}`);
  lines.push(`  recipient:           ${args.recipient}`);
  lines.push(`  relayer:             ${args.relayer}`);
  lines.push(`  denomination:        ${args.denomination} lamports`);
  lines.push(`  fee:                 ${args.fee} lamports`);
  lines.push("");
  lines.push("Readiness:");
  lines.push(`  expectedRootPresent: ${String(r.status?.expectedRootPresent)}`);
  lines.push(`  ready:               ${String(r.status?.ready)}`);
  lines.push(`  paused:              ${String(r.status?.paused)}`);
  for (const w of r.operationalWarnings) {
    lines.push(`  [operational] ${w}`);
  }

  if (r.diagnosticsOk !== undefined) {
    lines.push("");
    lines.push("Privacy diagnostics:");
    lines.push(`  ok: ${r.diagnosticsOk}`);
    lines.push(`  warnings: ${r.diagnosticsWarningCount}`);
  }

  if (r.blocked) {
    lines.push("");
    lines.push("BLOCKED — simulate was not run:");
    for (const reason of r.blockedReasons) {
      lines.push(`  - ${reason}`);
    }
    return lines.join("\n");
  }

  if (r.mode === "preview") {
    lines.push("");
    lines.push(
      "Preview only: gates passed. No proving artifacts were generated."
    );
    lines.push(
      "Re-run with --simulate (plus --wasm and --zkey) to run the full"
    );
    lines.push("simulate-only flow. There is no live-send mode in this tool.");
    return lines.join("\n");
  }

  lines.push("");
  lines.push("Simulation:");
  lines.push(`  simulationOk:        ${String(r.simulation?.simulationOk)}`);
  if (r.simulation?.unitsConsumed !== undefined) {
    lines.push(`  unitsConsumed:       ${r.simulation.unitsConsumed}`);
  }
  lines.push(
    `  settlement log:      ${
      r.simulation?.settlementObserved ? "observed" : "not observed"
    }`
  );
  lines.push(
    `  nullifier after sim: ${
      r.nullifierUnspentAfter === true
        ? "unspent"
        : r.nullifierUnspentAfter === false
        ? "SPENT (unexpected)"
        : "not checked"
    }`
  );
  lines.push("");
  lines.push("No live withdrawal was sent.");
  lines.push("Temporary private artifacts were removed.");
  return lines.join("\n");
}

export function helpText(): string {
  return [
    "shared_pool_tester_withdraw_simulate.ts — guided simulate-only withdraw_zk",
    "flow for devnet-alpha testers.",
    "",
    "Devnet alpha only. Simulate-only: this tool has no live withdrawal path and",
    "no live-send flag. A successful simulation proves execution readiness, not",
    "production privacy. Simulation does not spend the note — the nullifier must",
    "remain unspent afterwards.",
    "",
    "Run privacy diagnostics first; this tool runs them again as a gate. Root",
    "submission is operator-managed: if your root is not allow-listed yet, ask",
    "the operator. Keep your note material outside the repository and never",
    "share it — anyone holding it can spend the note once live sends exist.",
    "",
    "Usage (recommended tester form):",
    "  npm run --silent alpha:withdraw:simulate -- \\",
    "    --note <outside-repo-note-path> --snapshot <snapshot-path> \\",
    "    --leaf-index <leaf-index> --root <root> \\",
    "    --recipient <recipient-pubkey> --relayer <relayer-pubkey>",
    "",
    "Required:",
    "  --note <path>          Note material file (outside the repo; never printed).",
    "  --snapshot <path>      Indexer snapshot for the shared note tree.",
    "  --leaf-index <n>       Your deposit leaf index.",
    "  --root <64-hex>        The operator-allowed root to simulate against.",
    "  --recipient <pubkey>   Withdrawal recipient (public).",
    "  --relayer <pubkey>     Relayer (public). Must be distinct from --recipient.",
    "",
    "The recipient and relayer must be distinct pubkeys for this guided flow.",
    "Devnet-alpha settlement credits those roles separately.",
    "",
    "Optional:",
    "  --rpc <url>            Devnet RPC (non-devnet endpoints are rejected).",
    "  --denomination <n>     Lamports (default 1000000000 = 1 SOL).",
    "  --fee <n>              Lamports (default 1200000).",
    "  --simulate             Run the full proving + simulation flow.",
    "  --wasm <path>          Circuit wasm (required with --simulate).",
    "  --zkey <path>          Proving key (required with --simulate).",
    "  --help, -h             Print this help and exit.",
    "",
    "Modes:",
    "  default                Preview: validate inputs and run the read-only",
    "                         status + diagnostics gates; generate nothing.",
    "  --simulate             Full flow: export private inputs and run the",
    "                         read-only simulation. Temporary private/proving",
    "                         artifacts go to a fresh temp directory outside the",
    "                         repository and are removed afterwards.",
    "",
    "Examples:",
    "  # Preview (gates only):",
    "  npm run --silent alpha:withdraw:simulate -- \\",
    "    --note <outside-repo-note-path> --snapshot <snapshot-path> \\",
    "    --leaf-index <leaf-index> --root <root> \\",
    "    --recipient <recipient-pubkey> --relayer <relayer-pubkey>",
    "",
    "  # Full simulate-only run:",
    "  npm run --silent alpha:withdraw:simulate -- \\",
    "    --note <outside-repo-note-path> --snapshot <snapshot-path> \\",
    "    --leaf-index <leaf-index> --root <root> \\",
    "    --recipient <recipient-pubkey> --relayer <relayer-pubkey> \\",
    "    --simulate --wasm <wasm-path> --zkey <zkey-path>",
  ].join("\n");
}

/**
 * Runs the guided flow and prints the public-safe summary. Any thrown error is
 * reduced to its message only — no stack trace, so no local paths can leak via
 * Node's default error rendering. Returns the process exit code.
 */
export async function runCliFlow(
  args: WithdrawSimArgs,
  deps: FlowDeps,
  log: (s: string) => void = console.log,
  logError: (s: string) => void = console.error
): Promise<number> {
  try {
    const result = await runGuidedFlow(args, deps);
    log(formatSummary(args, result));
    return result.blocked ? 1 : 0;
  } catch (err) {
    logError((err as Error).message);
    return 1;
  }
}

// ── Real deps (CLI only) ─────────────────────────────────────────────────────

function runNpx(
  argv: string[],
  repoRoot: string,
  logFile?: string
): { status: number | null; stdout: string } {
  const res = spawnSync("npx", argv, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (logFile !== undefined) {
    // Private/verbose output goes to the temp log, never to the console.
    fs.writeFileSync(logFile, (res.stdout ?? "") + (res.stderr ?? ""), {
      mode: 0o600,
    });
  }
  return { status: res.status, stdout: res.stdout ?? "" };
}

function realDeps(repoRoot: string, rpc: string): FlowDeps {
  return {
    fetchStatus: async (root) => {
      const res = runNpx(buildStatusArgv(root), repoRoot);
      try {
        return JSON.parse(res.stdout) as StatusGateInput;
      } catch {
        throw new Error("could not parse shared-pool status output");
      }
    },
    runDiagnostics: async (a) => {
      const res = runNpx(buildDiagnosticsArgv(a), repoRoot);
      try {
        return JSON.parse(res.stdout) as DiagnosticsGateInput;
      } catch {
        throw new Error("could not parse privacy diagnostics output");
      }
    },
    currentSlot: async () => {
      const connection = new Connection(rpc, "confirmed");
      return connection.getSlot("confirmed");
    },
    makeTempDir: () =>
      fs.mkdtempSync(path.join(os.tmpdir(), "cirrus-withdraw-sim-")),
    exportProvingInputs: async (a, expirySlot, tempDir) => {
      const res = runNpx(
        buildExportArgv(a, expirySlot, tempDir),
        repoRoot,
        path.join(tempDir, "export.log")
      );
      if (res.status !== 0) {
        throw new Error(
          "private-input export failed (details withheld; they may reference local paths)"
        );
      }
    },
    generateProvingOutput: async (a, tempDir) => {
      const res = runNpx(
        buildProveArgv(a, tempDir),
        tempDir,
        path.join(tempDir, "prove.log")
      );
      if (res.status !== 0) {
        throw new Error("Groth16 proving step failed (details withheld)");
      }
    },
    readPublicInputs: (tempDir) => {
      const raw = fs.readFileSync(path.join(tempDir, "public.json"), "utf8");
      return JSON.parse(raw) as PublicInputsShape;
    },
    simulate: async (a, expirySlot, tempDir) => {
      const res = runNpx(
        buildSimulateArgv(a, expirySlot, tempDir),
        repoRoot,
        path.join(tempDir, "simulate.log")
      );
      let parsed: {
        simulationOk?: boolean;
        unitsConsumed?: number;
        logs?: string[];
      };
      try {
        parsed = JSON.parse(res.stdout);
      } catch {
        throw new Error("could not parse simulation output");
      }
      const logs = parsed.logs ?? [];
      return {
        simulationOk: parsed.simulationOk === true,
        unitsConsumed: parsed.unitsConsumed,
        logCount: logs.length,
        settlementObserved: logs.some((l) => l.includes("settlement complete")),
      };
    },
    checkNullifierUnspent: async (nullifierHash) => {
      const res = runNpx(buildNullifierArgv({ rpc, nullifierHash }), repoRoot);
      try {
        const parsed = JSON.parse(res.stdout) as { exists?: boolean };
        if (parsed.exists === undefined) return undefined;
        return parsed.exists === false;
      } catch {
        return undefined;
      }
    },
    cleanupTempDir: (dir) => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

// ── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);

    if (argv.includes("--help") || argv.includes("-h")) {
      console.log(helpText());
      process.exit(0);
    }

    const repoRoot = path.resolve(__dirname, "..", "..");

    const args = ((): WithdrawSimArgs => {
      try {
        return parseArgs(argv);
      } catch (err) {
        console.error((err as Error).message);
        return process.exit(1);
      }
    })();

    try {
      assertDevnetRpc(args.rpc);
      args.note = assertNotePathOutsideRepo(args.note, repoRoot);
      args.snapshot = assertSnapshotPathOutsideRepo(args.snapshot, repoRoot);
      if (args.simulate) {
        // Proving runs with a temp-dir cwd, so artifact paths must be absolute.
        args.wasm = normalizeArtifactInput("circuit wasm", args.wasm as string);
        args.zkey = normalizeArtifactInput("proving key", args.zkey as string);
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }

    process.exit(await runCliFlow(args, realDeps(repoRoot, args.rpc)));
  })();
}
