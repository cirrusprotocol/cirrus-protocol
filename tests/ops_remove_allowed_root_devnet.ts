import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import {
  PROGRAM_ID,
  CONFIRM_PHRASE,
  RemoveAllowedRootArgs,
  RemoveAllowedRootDeps,
  RemoveAllowedRootConfigData,
  parseRemoveAllowedRootArgs,
  runRemoveAllowedRoot,
} from "../scripts/ops/remove_allowed_root_devnet";

// ── Constants ─────────────────────────────────────────────────────────────────

const SCRIPT_PATH = path.join(
  __dirname,
  "..",
  "scripts",
  "ops",
  "remove_allowed_root_devnet.ts"
);

const RPC = "https://api.devnet.solana.com";

const VALID_ROOT =
  "2a065f5ccc90a22c2d5789d4ec9c65dc0189c18c43c785d3ac54fd00e93f8dd3";

const VALID_ROOT_UPPER =
  "2A065F5CCC90A22C2D5789D4EC9C65DC0189C18C43C785D3AC54FD00E93F8DD3";

const OTHER_ROOT =
  "1b1c2d3e4f5a6b7c8d9eaf0112233445566778899aabbccddeeff00112233445";

const ROOT_SUBMITTER_PUBKEY = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

const OTHER_PUBKEY = new PublicKey(
  "FTu67mwyPuoaRB7U3zewHfAmRXvHC7y7zEt5a5eEwx8o"
);

// ── Helpers ───────────────────────────────────────────────────────────────────

interface DepsBundle {
  deps: RemoveAllowedRootDeps;
  callCount: { send: number };
}

function makeDeps(
  rootsInRegistry: string[],
  rootsAfterRemoval: string[],
  rootSubmitterAuthority: PublicKey = ROOT_SUBMITTER_PUBKEY,
  walletPubkey: PublicKey = ROOT_SUBMITTER_PUBKEY
): DepsBundle {
  const callCount = { send: 0 };
  return {
    callCount,
    deps: {
      rootSubmitterPubkey: walletPubkey,
      fetchConfig: async (): Promise<RemoveAllowedRootConfigData> => ({
        rootSubmitterAuthority,
        allowedRoots: rootsInRegistry.map((h) => Buffer.from(h, "hex")),
      }),
      sendRemoveAllowedRoot: async (): Promise<string> => {
        callCount.send++;
        return "mockTxSig1234";
      },
      refetchConfig: async (): Promise<RemoveAllowedRootConfigData> => ({
        rootSubmitterAuthority,
        allowedRoots: rootsAfterRemoval.map((h) => Buffer.from(h, "hex")),
      }),
    },
  };
}

function dryRunArgs(
  overrides: Partial<RemoveAllowedRootArgs> = {}
): RemoveAllowedRootArgs {
  return {
    rpcUrl: RPC,
    programId: PROGRAM_ID,
    root: VALID_ROOT,
    dryRun: true,
    yes: false,
    commitment: "confirmed",
    ...overrides,
  };
}

function yesArgs(
  overrides: Partial<RemoveAllowedRootArgs> = {}
): RemoveAllowedRootArgs {
  return {
    rpcUrl: RPC,
    programId: PROGRAM_ID,
    root: VALID_ROOT,
    dryRun: false,
    yes: true,
    rootSubmitterKeypairPath: "/fake/root_submitter.json",
    confirmPhrase: CONFIRM_PHRASE,
    commitment: "confirmed",
    ...overrides,
  };
}

// ── 1. Parser tests ───────────────────────────────────────────────────────────

describe("parseRemoveAllowedRootArgs — required flags", () => {
  it("1. requires --rpc-url", () => {
    expect(() =>
      parseRemoveAllowedRootArgs([
        "--program-id",
        PROGRAM_ID,
        "--root",
        VALID_ROOT,
        "--dry-run",
      ])
    ).to.throw(/--rpc-url is required/);
  });

  it("2. requires --program-id", () => {
    expect(() =>
      parseRemoveAllowedRootArgs([
        "--rpc-url",
        RPC,
        "--root",
        VALID_ROOT,
        "--dry-run",
      ])
    ).to.throw(/--program-id is required/);
  });

  it("3. requires --root", () => {
    expect(() =>
      parseRemoveAllowedRootArgs([
        "--rpc-url",
        RPC,
        "--program-id",
        PROGRAM_ID,
        "--dry-run",
      ])
    ).to.throw(/--root is required/);
  });

  it("4. rejects root shorter than 64 hex chars", () => {
    expect(() =>
      parseRemoveAllowedRootArgs([
        "--rpc-url",
        RPC,
        "--program-id",
        PROGRAM_ID,
        "--root",
        "abcd",
        "--dry-run",
      ])
    ).to.throw();
  });

  it("5. rejects non-hex root of correct length", () => {
    expect(() =>
      parseRemoveAllowedRootArgs([
        "--rpc-url",
        RPC,
        "--program-id",
        PROGRAM_ID,
        "--root",
        "z".repeat(64),
        "--dry-run",
      ])
    ).to.throw();
  });

  it("6. normalizes uppercase root to lowercase", () => {
    const a = parseRemoveAllowedRootArgs([
      "--rpc-url",
      RPC,
      "--program-id",
      PROGRAM_ID,
      "--root",
      VALID_ROOT_UPPER,
      "--dry-run",
    ]);
    expect(a.root).to.equal(VALID_ROOT);
  });

  it("7. parses --dry-run mode correctly", () => {
    const a = parseRemoveAllowedRootArgs([
      "--rpc-url",
      RPC,
      "--program-id",
      PROGRAM_ID,
      "--root",
      VALID_ROOT,
      "--dry-run",
    ]);
    expect(a.dryRun).to.be.true;
    expect(a.yes).to.be.false;
  });

  it("8. parses --yes with keypair and confirm phrase", () => {
    const a = parseRemoveAllowedRootArgs([
      "--rpc-url",
      RPC,
      "--program-id",
      PROGRAM_ID,
      "--root",
      VALID_ROOT,
      "--root-submitter-keypair",
      "/path/key.json",
      "--confirm",
      CONFIRM_PHRASE,
      "--yes",
    ]);
    expect(a.yes).to.be.true;
    expect(a.dryRun).to.be.false;
    expect(a.rootSubmitterKeypairPath).to.equal("/path/key.json");
    expect(a.confirmPhrase).to.equal(CONFIRM_PHRASE);
  });

  it("9. rejects --dry-run combined with --yes", () => {
    expect(() =>
      parseRemoveAllowedRootArgs([
        "--rpc-url",
        RPC,
        "--program-id",
        PROGRAM_ID,
        "--root",
        VALID_ROOT,
        "--dry-run",
        "--root-submitter-keypair",
        "/k.json",
        "--confirm",
        CONFIRM_PHRASE,
        "--yes",
      ])
    ).to.throw(/mutually exclusive/);
  });

  it("10. --yes requires --root-submitter-keypair", () => {
    expect(() =>
      parseRemoveAllowedRootArgs([
        "--rpc-url",
        RPC,
        "--program-id",
        PROGRAM_ID,
        "--root",
        VALID_ROOT,
        "--confirm",
        CONFIRM_PHRASE,
        "--yes",
      ])
    ).to.throw(/--root-submitter-keypair/);
  });

  it("11. --yes requires exact confirm phrase", () => {
    expect(() =>
      parseRemoveAllowedRootArgs([
        "--rpc-url",
        RPC,
        "--program-id",
        PROGRAM_ID,
        "--root",
        VALID_ROOT,
        "--root-submitter-keypair",
        "/k.json",
        "--confirm",
        "wrong phrase",
        "--yes",
      ])
    ).to.throw(/REMOVE ROOT FROM DEVNET/);
  });

  it("12. rejects invalid --commitment value", () => {
    expect(() =>
      parseRemoveAllowedRootArgs([
        "--rpc-url",
        RPC,
        "--program-id",
        PROGRAM_ID,
        "--root",
        VALID_ROOT,
        "--commitment",
        "instant",
        "--dry-run",
      ])
    ).to.throw(/commitment/);
  });

  it("13. rejects unknown flag", () => {
    expect(() =>
      parseRemoveAllowedRootArgs([
        "--rpc-url",
        RPC,
        "--program-id",
        PROGRAM_ID,
        "--root",
        VALID_ROOT,
        "--dry-run",
        "--bogus",
      ])
    ).to.throw(/unknown flag/);
  });
});

// ── 2. Preflight / plan tests ─────────────────────────────────────────────────

describe("runRemoveAllowedRoot — preflight", () => {
  it("14. dry-run: returns rootFound=true, sent=false when root is in registry", async () => {
    const { deps, callCount } = makeDeps([VALID_ROOT], []);
    const result = await runRemoveAllowedRoot(dryRunArgs(), deps);
    expect(result.rootFound).to.be.true;
    expect(result.dryRun).to.be.true;
    expect(result.sent).to.be.false;
    expect(result.postSendVerified).to.be.false;
    expect(callCount.send).to.equal(0);
  });

  it("15. dry-run: throws when root is not in registry; send not called", async () => {
    const { deps, callCount } = makeDeps([OTHER_ROOT], []);
    let err: Error | undefined;
    try {
      await runRemoveAllowedRoot(dryRunArgs(), deps);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.match(/not found/);
    expect(callCount.send).to.equal(0);
  });

  it("16. computes currentRootCount and remainingRootsAfterRemoval correctly", async () => {
    const { deps } = makeDeps([VALID_ROOT, OTHER_ROOT], []);
    const result = await runRemoveAllowedRoot(dryRunArgs(), deps);
    expect(result.currentRootCount).to.equal(2);
    expect(result.remainingRootsAfterRemoval).to.equal(1);
  });

  it("17. sets wouldLeaveEmpty=true when target is the last root", async () => {
    const { deps } = makeDeps([VALID_ROOT], []);
    const result = await runRemoveAllowedRoot(dryRunArgs(), deps);
    expect(result.wouldLeaveEmpty).to.be.true;
  });

  it("18. sets wouldLeaveEmpty=false when other roots remain after removal", async () => {
    const { deps } = makeDeps([VALID_ROOT, OTHER_ROOT], []);
    const result = await runRemoveAllowedRoot(dryRunArgs(), deps);
    expect(result.wouldLeaveEmpty).to.be.false;
  });

  it("19. keypair mismatch throws before send; send not called", async () => {
    const { deps, callCount } = makeDeps(
      [VALID_ROOT],
      [],
      OTHER_PUBKEY,
      ROOT_SUBMITTER_PUBKEY
    );
    let err: Error | undefined;
    try {
      await runRemoveAllowedRoot(yesArgs(), deps);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.match(/mismatch/);
    expect(callCount.send).to.equal(0);
  });

  it("20. keypair match allows yes mode to proceed past preflight", async () => {
    const { deps } = makeDeps(
      [VALID_ROOT],
      [],
      ROOT_SUBMITTER_PUBKEY,
      ROOT_SUBMITTER_PUBKEY
    );
    const result = await runRemoveAllowedRoot(yesArgs(), deps);
    expect(result.sent).to.be.true;
  });
});

// ── 3. Send behaviour tests ───────────────────────────────────────────────────

describe("runRemoveAllowedRoot — send behaviour", () => {
  it("21. send mode calls sendRemoveAllowedRoot exactly once", async () => {
    const { deps, callCount } = makeDeps(
      [VALID_ROOT],
      [],
      ROOT_SUBMITTER_PUBKEY,
      ROOT_SUBMITTER_PUBKEY
    );
    await runRemoveAllowedRoot(yesArgs(), deps);
    expect(callCount.send).to.equal(1);
  });

  it("22. send is not called when root is not in registry", async () => {
    const { deps, callCount } = makeDeps(
      [OTHER_ROOT],
      [],
      ROOT_SUBMITTER_PUBKEY,
      ROOT_SUBMITTER_PUBKEY
    );
    let err: Error | undefined;
    try {
      await runRemoveAllowedRoot(yesArgs(), deps);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.match(/not found/);
    expect(callCount.send).to.equal(0);
  });

  it("23. send is not called when keypair does not match root_submitter_authority", async () => {
    const { deps, callCount } = makeDeps(
      [VALID_ROOT],
      [],
      OTHER_PUBKEY,
      ROOT_SUBMITTER_PUBKEY
    );
    let err: Error | undefined;
    try {
      await runRemoveAllowedRoot(yesArgs(), deps);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.match(/mismatch/);
    expect(callCount.send).to.equal(0);
  });

  it("24. post-send verification succeeds when root is absent in refetch", async () => {
    const { deps } = makeDeps(
      [VALID_ROOT],
      [],
      ROOT_SUBMITTER_PUBKEY,
      ROOT_SUBMITTER_PUBKEY
    );
    const result = await runRemoveAllowedRoot(yesArgs(), deps);
    expect(result.postSendVerified).to.be.true;
    expect(result.txSignature).to.equal("mockTxSig1234");
  });

  it("25. post-send verification throws when root still present in refetch", async () => {
    const { deps } = makeDeps(
      [VALID_ROOT],
      [VALID_ROOT],
      ROOT_SUBMITTER_PUBKEY,
      ROOT_SUBMITTER_PUBKEY
    );
    let err: Error | undefined;
    try {
      await runRemoveAllowedRoot(yesArgs(), deps);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.match(/still present/);
  });
});

// ── 4. Static safety scan ─────────────────────────────────────────────────────

describe("remove_allowed_root_devnet: source scan", () => {
  let src: string;

  before(() => {
    src = fs.readFileSync(SCRIPT_PATH, "utf8");
  });

  it("26. script does not call Keypair.generate", () => {
    expect(src).to.not.include(["Keypair", ".", "generate"].join(""));
  });

  it("27. script does not call sendRawTransaction", () => {
    expect(src).to.not.include(["send", "Raw", "Transaction"].join(""));
  });

  it("28. script does not call addAllowedRoot or add_allowed_root", () => {
    expect(src).to.not.include(["add", "AllowedRoot"].join(""));
    expect(src).to.not.include(["add", "_allowed_root"].join(""));
  });

  it("29. script does not call deposit_note or withdraw_zk instructions", () => {
    expect(src).to.not.include(["deposit", "_note("].join(""));
    expect(src).to.not.include(["withdraw", "_zk("].join(""));
    expect(src).to.not.include(["deposit", "Note("].join(""));
    expect(src).to.not.include(["withdraw", "Zk("].join(""));
  });

  it("30. sendRemoveAllowedRoot call appears after the yes guard in source", () => {
    const yesGuard = "if (!args.yes)";
    const sendCall = "deps.sendRemoveAllowedRoot";
    const guardIdx = src.indexOf(yesGuard);
    const sendIdx = src.indexOf(sendCall);
    expect(guardIdx).to.be.greaterThan(-1, "yes guard not found in source");
    expect(sendIdx).to.be.greaterThan(
      -1,
      "sendRemoveAllowedRoot call not found in source"
    );
    expect(sendIdx).to.be.greaterThan(
      guardIdx,
      "sendRemoveAllowedRoot call must appear after the yes guard"
    );
  });

  it("31. no-mode guard appears in source before parseRemoveAllowedRootArgs call", () => {
    // The raw-argv no-mode check must fire before parsing so that running the
    // script with no --dry-run / --yes never requires --rpc-url or --root.
    const noModeGuard = ['argv.includes("--', "dry-run", '")'].join("");
    const parseCall = "parseRemoveAllowedRootArgs(argv)";
    const guardIdx = src.indexOf(noModeGuard);
    const parseIdx = src.indexOf(parseCall);
    expect(guardIdx).to.be.greaterThan(
      -1,
      "no-mode argv guard not found in source"
    );
    expect(parseIdx).to.be.greaterThan(
      -1,
      "parseRemoveAllowedRootArgs call not found"
    );
    expect(guardIdx).to.be.lessThan(
      parseIdx,
      "no-mode guard must appear before parseRemoveAllowedRootArgs"
    );
  });
});
