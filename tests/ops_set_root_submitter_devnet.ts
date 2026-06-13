import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import {
  PROGRAM_ID,
  SetRootSubmitterArgs,
  SetRootSubmitterDeps,
  parseArgs,
  deriveConfigPda,
  runSetRootSubmitter,
  validateIdlAddress,
} from "../scripts/ops/set_root_submitter_devnet";

// ── Test constants ────────────────────────────────────────────────────────────

const SCRIPT_PATH = path.join(
  __dirname,
  "..",
  "scripts",
  "ops",
  "set_root_submitter_devnet.ts"
);

const KNOWN_PROGRAM_ID = "E593efjkVU3Z6pJQtSLf7jECFeGBVy2UQZwET4nqLhyq";
const KNOWN_CONFIG_PDA = "6DUXKzex1nLyFSvAfRRneaukfH1YXrQQ6t58vcYZpHJu";

const ADMIN_PUBKEY = new PublicKey(
  "FTu67mwyPuoaRB7U3zewHfAmRXvHC7y7zEt5a5eEwx8o"
);
const NEW_ROOT_SUBMITTER = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
// Distinct wrong-admin key (Wrapped SOL program ID — a valid non-zero key).
const WRONG_ADMIN = new PublicKey(
  "So11111111111111111111111111111111111111112"
);
const DEFAULT_PUBKEY_STR = "11111111111111111111111111111111";

// ── Helpers ───────────────────────────────────────────────────────────────────

function dryRunArgs(
  overrides: Partial<SetRootSubmitterArgs> = {}
): SetRootSubmitterArgs {
  return {
    newRootSubmitter: NEW_ROOT_SUBMITTER,
    programId: PROGRAM_ID,
    commitment: "confirmed",
    dryRun: true,
    yes: false,
    ...overrides,
  };
}

function yesArgs(
  overrides: Partial<SetRootSubmitterArgs> = {}
): SetRootSubmitterArgs {
  return {
    newRootSubmitter: NEW_ROOT_SUBMITTER,
    programId: PROGRAM_ID,
    commitment: "confirmed",
    dryRun: false,
    yes: true,
    ...overrides,
  };
}

function makeSuccessDeps(): SetRootSubmitterDeps {
  return {
    adminPubkey: ADMIN_PUBKEY,
    fetchConfig: async () => ({
      adminAuthority: ADMIN_PUBKEY,
      rootSubmitterAuthority: ADMIN_PUBKEY,
    }),
    sendSetRootSubmitter: async () => "mockTxSig",
    refetchConfig: async () => ({
      adminAuthority: ADMIN_PUBKEY,
      rootSubmitterAuthority: NEW_ROOT_SUBMITTER,
    }),
  };
}

// ── Module guard ──────────────────────────────────────────────────────────────

describe("set_root_submitter_devnet: module guard", () => {
  it("1. exports are accessible; require.main guard prevents CLI execution on import", () => {
    expect(PROGRAM_ID).to.be.a("string").with.length.greaterThan(0);
    expect(parseArgs).to.be.a("function");
    expect(deriveConfigPda).to.be.a("function");
    expect(runSetRootSubmitter).to.be.a("function");
    expect(validateIdlAddress).to.be.a("function");
  });

  it("2. PROGRAM_ID matches the known deployment address", () => {
    expect(PROGRAM_ID).to.equal(KNOWN_PROGRAM_ID);
  });

  it("3. deriveConfigPda produces the known config PDA for the known program ID", () => {
    const [pda] = deriveConfigPda(new PublicKey(KNOWN_PROGRAM_ID));
    expect(pda.toBase58()).to.equal(KNOWN_CONFIG_PDA);
  });
});

// ── validateIdlAddress ────────────────────────────────────────────────────────

describe("set_root_submitter_devnet: validateIdlAddress", () => {
  it("4. rejects missing address field", () => {
    expect(() => validateIdlAddress({})).to.throw(/missing/i);
  });

  it("5. rejects an address that is not a valid public key", () => {
    expect(() => validateIdlAddress({ address: "not-a-pubkey" })).to.throw(
      /not a valid public key/i
    );
  });

  it("6. rejects a valid pubkey that does not match PROGRAM_ID", () => {
    expect(() =>
      validateIdlAddress({ address: "11111111111111111111111111111111" })
    ).to.throw(/mismatch/i);
  });

  it("7. accepts PROGRAM_ID and returns a PublicKey equal to PROGRAM_ID", () => {
    const pk = validateIdlAddress({ address: PROGRAM_ID });
    expect(pk).to.be.instanceof(PublicKey);
    expect(pk.toBase58()).to.equal(PROGRAM_ID);
  });
});

// ── parseArgs ─────────────────────────────────────────────────────────────────

describe("set_root_submitter_devnet: parseArgs", () => {
  it("8. missing --new-root-submitter with --dry-run throws", () => {
    expect(() => parseArgs(["--dry-run"])).to.throw(
      /--new-root-submitter is required/
    );
  });

  it("9. missing --new-root-submitter with --yes throws", () => {
    expect(() => parseArgs(["--yes"])).to.throw(
      /--new-root-submitter is required/
    );
  });

  it("10. valid --new-root-submitter with --dry-run accepts; dryRun=true, yes=false", () => {
    const args = parseArgs([
      "--new-root-submitter",
      NEW_ROOT_SUBMITTER.toBase58(),
      "--dry-run",
    ]);
    expect(args.newRootSubmitter!.toBase58()).to.equal(
      NEW_ROOT_SUBMITTER.toBase58()
    );
    expect(args.dryRun).to.equal(true);
    expect(args.yes).to.equal(false);
  });

  it("11. valid --new-root-submitter with --yes accepts; yes=true, dryRun=false", () => {
    const args = parseArgs([
      "--new-root-submitter",
      NEW_ROOT_SUBMITTER.toBase58(),
      "--yes",
    ]);
    expect(args.newRootSubmitter!.toBase58()).to.equal(
      NEW_ROOT_SUBMITTER.toBase58()
    );
    expect(args.yes).to.equal(true);
    expect(args.dryRun).to.equal(false);
  });

  it("12. invalid pubkey for --new-root-submitter throws", () => {
    expect(() =>
      parseArgs(["--new-root-submitter", "not-a-pubkey", "--dry-run"])
    ).to.throw(/not a valid public key/);
  });

  it("13. default (all-zero) pubkey for --new-root-submitter throws", () => {
    expect(() =>
      parseArgs(["--new-root-submitter", DEFAULT_PUBKEY_STR, "--dry-run"])
    ).to.throw(/default.*key/i);
  });

  it("14. --dry-run and --yes together throw mutually exclusive error", () => {
    expect(() =>
      parseArgs([
        "--new-root-submitter",
        NEW_ROOT_SUBMITTER.toBase58(),
        "--dry-run",
        "--yes",
      ])
    ).to.throw(/mutually exclusive/);
  });

  it("15. accepts --commitment confirmed", () => {
    const args = parseArgs([
      "--new-root-submitter",
      NEW_ROOT_SUBMITTER.toBase58(),
      "--dry-run",
      "--commitment",
      "confirmed",
    ]);
    expect(args.commitment).to.equal("confirmed");
  });

  it("16. accepts --commitment finalized", () => {
    const args = parseArgs([
      "--new-root-submitter",
      NEW_ROOT_SUBMITTER.toBase58(),
      "--dry-run",
      "--commitment",
      "finalized",
    ]);
    expect(args.commitment).to.equal("finalized");
  });

  it("17. accepts --commitment processed", () => {
    const args = parseArgs([
      "--new-root-submitter",
      NEW_ROOT_SUBMITTER.toBase58(),
      "--dry-run",
      "--commitment",
      "processed",
    ]);
    expect(args.commitment).to.equal("processed");
  });

  it("18. rejects invalid --commitment value", () => {
    expect(() =>
      parseArgs([
        "--new-root-submitter",
        NEW_ROOT_SUBMITTER.toBase58(),
        "--dry-run",
        "--commitment",
        "instant",
      ])
    ).to.throw(/--commitment must be/);
  });

  it("19. rejects unknown flag", () => {
    expect(() =>
      parseArgs([
        "--new-root-submitter",
        NEW_ROOT_SUBMITTER.toBase58(),
        "--unknown",
      ])
    ).to.throw(/unknown flag/);
  });

  it("20. default program ID used if --program-id is omitted", () => {
    const args = parseArgs([
      "--new-root-submitter",
      NEW_ROOT_SUBMITTER.toBase58(),
      "--dry-run",
    ]);
    expect(args.programId).to.equal(PROGRAM_ID);
  });

  it("21. custom --program-id accepted", () => {
    const customId = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const args = parseArgs([
      "--new-root-submitter",
      NEW_ROOT_SUBMITTER.toBase58(),
      "--dry-run",
      "--program-id",
      customId,
    ]);
    expect(args.programId).to.equal(customId);
  });

  it("22. default commitment is confirmed", () => {
    const args = parseArgs([
      "--new-root-submitter",
      NEW_ROOT_SUBMITTER.toBase58(),
      "--dry-run",
    ]);
    expect(args.commitment).to.equal("confirmed");
  });

  it("23. no flags: dryRun=false, yes=false, newRootSubmitter=undefined, defaults intact", () => {
    const args = parseArgs([]);
    expect(args.dryRun).to.equal(false);
    expect(args.yes).to.equal(false);
    expect(args.newRootSubmitter).to.be.undefined;
    expect(args.programId).to.equal(PROGRAM_ID);
    expect(args.commitment).to.equal("confirmed");
  });

  it("24. --new-root-submitter missing value throws", () => {
    expect(() => parseArgs(["--new-root-submitter"])).to.throw(
      /requires a value/
    );
  });

  it("25. --commitment missing value throws", () => {
    expect(() =>
      parseArgs([
        "--new-root-submitter",
        NEW_ROOT_SUBMITTER.toBase58(),
        "--dry-run",
        "--commitment",
      ])
    ).to.throw(/requires a value/);
  });

  it("26. --program-id missing value throws", () => {
    expect(() =>
      parseArgs([
        "--new-root-submitter",
        NEW_ROOT_SUBMITTER.toBase58(),
        "--dry-run",
        "--program-id",
      ])
    ).to.throw(/requires a value/);
  });

  it("27. invalid --program-id throws", () => {
    expect(() =>
      parseArgs([
        "--new-root-submitter",
        NEW_ROOT_SUBMITTER.toBase58(),
        "--dry-run",
        "--program-id",
        "not-a-key",
      ])
    ).to.throw(/not a valid public key/);
  });
});

// ── runSetRootSubmitter dry-run ───────────────────────────────────────────────

describe("set_root_submitter_devnet: runSetRootSubmitter dry-run", () => {
  it("28. dry-run returns dryRun=true, sent=false, postSendVerified=false, no txSignature", async () => {
    const result = await runSetRootSubmitter(dryRunArgs(), makeSuccessDeps());
    expect(result.dryRun).to.equal(true);
    expect(result.sent).to.equal(false);
    expect(result.postSendVerified).to.equal(false);
    expect(result.txSignature).to.be.undefined;
  });

  it("29. dry-run fetches config and populates current and proposed values in result", async () => {
    const result = await runSetRootSubmitter(dryRunArgs(), makeSuccessDeps());
    expect(result.adminAuthority).to.equal(ADMIN_PUBKEY.toBase58());
    expect(result.previousRootSubmitter).to.equal(ADMIN_PUBKEY.toBase58());
    expect(result.proposedRootSubmitter).to.equal(
      NEW_ROOT_SUBMITTER.toBase58()
    );
    expect(result.configPda).to.equal(KNOWN_CONFIG_PDA);
  });

  it("30. dry-run does not call sendSetRootSubmitter", async () => {
    let sendCalled = false;
    const deps = makeSuccessDeps();
    deps.sendSetRootSubmitter = async () => {
      sendCalled = true;
      return "never";
    };
    await runSetRootSubmitter(dryRunArgs(), deps);
    expect(sendCalled).to.equal(false);
  });

  it("31. dry-run reports no-op when proposed key equals current root_submitter_authority", async () => {
    const deps: SetRootSubmitterDeps = {
      adminPubkey: ADMIN_PUBKEY,
      fetchConfig: async () => ({
        adminAuthority: ADMIN_PUBKEY,
        rootSubmitterAuthority: NEW_ROOT_SUBMITTER,
      }),
      sendSetRootSubmitter: async () => "never",
      refetchConfig: async () => null,
    };
    const result = await runSetRootSubmitter(dryRunArgs(), deps);
    expect(result.noOp).to.equal(true);
    expect(result.sent).to.equal(false);
    expect(result.dryRun).to.equal(true);
  });

  it("32. dry-run with config not found throws clear error", async () => {
    const deps: SetRootSubmitterDeps = {
      adminPubkey: ADMIN_PUBKEY,
      fetchConfig: async () => null,
      sendSetRootSubmitter: async () => "never",
      refetchConfig: async () => null,
    };
    let err: Error | undefined;
    try {
      await runSetRootSubmitter(dryRunArgs(), deps);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("not found");
  });

  it("33. default (all-zero) key in args throws before any deps call", async () => {
    let fetchCalled = false;
    const deps: SetRootSubmitterDeps = {
      adminPubkey: ADMIN_PUBKEY,
      fetchConfig: async () => {
        fetchCalled = true;
        return {
          adminAuthority: ADMIN_PUBKEY,
          rootSubmitterAuthority: ADMIN_PUBKEY,
        };
      },
      sendSetRootSubmitter: async () => "never",
      refetchConfig: async () => null,
    };
    let err: Error | undefined;
    try {
      await runSetRootSubmitter(
        dryRunArgs({ newRootSubmitter: new PublicKey(DEFAULT_PUBKEY_STR) }),
        deps
      );
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("default");
    expect(fetchCalled).to.equal(false);
  });

  it("34. undefined newRootSubmitter throws before any deps call", async () => {
    let fetchCalled = false;
    const deps = makeSuccessDeps();
    const orig = deps.fetchConfig;
    deps.fetchConfig = async (pda) => {
      fetchCalled = true;
      return orig(pda);
    };
    let err: Error | undefined;
    try {
      await runSetRootSubmitter(
        dryRunArgs({ newRootSubmitter: undefined }),
        deps
      );
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("--new-root-submitter is required");
    expect(fetchCalled).to.equal(false);
  });

  it("35. neither dry-run nor yes throws '--yes is required'; send never called", async () => {
    let sendCalled = false;
    const deps = makeSuccessDeps();
    deps.sendSetRootSubmitter = async () => {
      sendCalled = true;
      return "never";
    };
    let err: Error | undefined;
    try {
      await runSetRootSubmitter(
        {
          newRootSubmitter: NEW_ROOT_SUBMITTER,
          programId: PROGRAM_ID,
          commitment: "confirmed",
          dryRun: false,
          yes: false,
        },
        deps
      );
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("--yes is required");
    expect(sendCalled).to.equal(false);
  });
});

// ── runSetRootSubmitter --yes mocked ──────────────────────────────────────────

describe("set_root_submitter_devnet: runSetRootSubmitter --yes mocked", () => {
  it("36. requires deps in yes mode", async () => {
    let err: Error | undefined;
    try {
      await runSetRootSubmitter(yesArgs());
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("deps are required");
  });

  it("37. config not found throws clear error", async () => {
    const deps: SetRootSubmitterDeps = {
      adminPubkey: ADMIN_PUBKEY,
      fetchConfig: async () => null,
      sendSetRootSubmitter: async () => "never",
      refetchConfig: async () => null,
    };
    let err: Error | undefined;
    try {
      await runSetRootSubmitter(yesArgs(), deps);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("not found");
  });

  it("38. wallet key not matching admin_authority throws; error includes both keys", async () => {
    const deps: SetRootSubmitterDeps = {
      adminPubkey: WRONG_ADMIN,
      fetchConfig: async () => ({
        adminAuthority: ADMIN_PUBKEY,
        rootSubmitterAuthority: ADMIN_PUBKEY,
      }),
      sendSetRootSubmitter: async () => "never",
      refetchConfig: async () => null,
    };
    let err: Error | undefined;
    try {
      await runSetRootSubmitter(yesArgs(), deps);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("admin_authority");
    expect(err!.message).to.include(WRONG_ADMIN.toBase58());
  });

  it("39. admin mismatch error occurs before send; send not called", async () => {
    let sendCalled = false;
    const deps: SetRootSubmitterDeps = {
      adminPubkey: WRONG_ADMIN,
      fetchConfig: async () => ({
        adminAuthority: ADMIN_PUBKEY,
        rootSubmitterAuthority: ADMIN_PUBKEY,
      }),
      sendSetRootSubmitter: async () => {
        sendCalled = true;
        return "never";
      },
      refetchConfig: async () => null,
    };
    let err: Error | undefined;
    try {
      await runSetRootSubmitter(yesArgs(), deps);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(sendCalled).to.equal(false);
  });

  it("40. no-op when proposed key already equals root_submitter_authority; send not called", async () => {
    let sendCalled = false;
    const deps: SetRootSubmitterDeps = {
      adminPubkey: ADMIN_PUBKEY,
      fetchConfig: async () => ({
        adminAuthority: ADMIN_PUBKEY,
        rootSubmitterAuthority: NEW_ROOT_SUBMITTER,
      }),
      sendSetRootSubmitter: async () => {
        sendCalled = true;
        return "never";
      },
      refetchConfig: async () => null,
    };
    const result = await runSetRootSubmitter(yesArgs(), deps);
    expect(sendCalled).to.equal(false);
    expect(result.sent).to.equal(false);
    expect(result.noOp).to.equal(true);
    expect(result.postSendVerified).to.equal(true);
  });

  it("41. happy path: send called exactly once with correct pubkey", async () => {
    let sendCount = 0;
    let receivedKey: PublicKey | undefined;
    const deps = makeSuccessDeps();
    deps.sendSetRootSubmitter = async (key) => {
      sendCount++;
      receivedKey = key;
      return "mockTxSig41";
    };
    const result = await runSetRootSubmitter(yesArgs(), deps);
    expect(sendCount).to.equal(1);
    expect(receivedKey!.toBase58()).to.equal(NEW_ROOT_SUBMITTER.toBase58());
    expect(result.txSignature).to.equal("mockTxSig41");
    expect(result.sent).to.equal(true);
  });

  it("42. happy path: postSendVerified=true, sent=true", async () => {
    const result = await runSetRootSubmitter(yesArgs(), makeSuccessDeps());
    expect(result.postSendVerified).to.equal(true);
    expect(result.sent).to.equal(true);
  });

  it("43. post-send mismatch throws clear error", async () => {
    const deps: SetRootSubmitterDeps = {
      adminPubkey: ADMIN_PUBKEY,
      fetchConfig: async () => ({
        adminAuthority: ADMIN_PUBKEY,
        rootSubmitterAuthority: ADMIN_PUBKEY,
      }),
      sendSetRootSubmitter: async () => "txSig",
      refetchConfig: async () => ({
        adminAuthority: ADMIN_PUBKEY,
        rootSubmitterAuthority: ADMIN_PUBKEY, // not updated — mismatch
      }),
    };
    let err: Error | undefined;
    try {
      await runSetRootSubmitter(yesArgs(), deps);
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("post-send verification failed");
  });

  it("44. default (all-zero) key in yes-mode args throws before any fetch", async () => {
    let fetchCalled = false;
    const deps: SetRootSubmitterDeps = {
      adminPubkey: ADMIN_PUBKEY,
      fetchConfig: async () => {
        fetchCalled = true;
        return {
          adminAuthority: ADMIN_PUBKEY,
          rootSubmitterAuthority: ADMIN_PUBKEY,
        };
      },
      sendSetRootSubmitter: async () => "never",
      refetchConfig: async () => null,
    };
    let err: Error | undefined;
    try {
      await runSetRootSubmitter(
        yesArgs({ newRootSubmitter: new PublicKey(DEFAULT_PUBKEY_STR) }),
        deps
      );
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.exist;
    expect(err!.message).to.include("default");
    expect(fetchCalled).to.equal(false);
  });
});

// ── Source scan ───────────────────────────────────────────────────────────────
//
// Forbidden patterns are built with join() so this file itself does not
// contain them as literal strings and does not self-flag under the repo grep.

describe("set_root_submitter_devnet: source scan", () => {
  const join = (...parts: string[]) => parts.join("");
  let src: string;

  before(() => {
    src = fs.readFileSync(SCRIPT_PATH, "utf8");
  });

  it("45. script does not contain keypair generation pattern", () => {
    expect(src).to.not.include(join("Keypair", ".", "generate"));
  });

  it("46. script does not contain airdrop request pattern", () => {
    expect(src).to.not.include(join("request", "Airdrop"));
  });

  it("47. script does not call the note-deposit instruction", () => {
    expect(src).to.not.include(join("deposit", "_note("));
    expect(src).to.not.include(join("deposit", "Note("));
  });

  it("48. script does not call the ZK withdrawal instruction", () => {
    expect(src).to.not.include(join("withdraw", "_zk("));
    expect(src).to.not.include(join("withdraw", "Zk("));
  });

  it("49. script does not call the allowed-root add instruction", () => {
    expect(src).to.not.include(join("add", "AllowedRoot("));
    expect(src).to.not.include(join(".", "add", "_allowed_root("));
  });

  it("50. script does not call the allowed-root remove instruction", () => {
    expect(src).to.not.include(join("remove", "AllowedRoot("));
    expect(src).to.not.include(join(".", "remove", "_allowed_root("));
  });

  it("51. sendSetRootSubmitter call site is after the yes guard in source", () => {
    const guard = "if (!args.yes)";
    const sendCall = join("await deps.", "sendSetRootSubmitter");
    const guardIdx = src.indexOf(guard);
    const sendIdx = src.indexOf(sendCall);
    expect(guardIdx, "yes guard must exist in source").to.be.greaterThan(-1);
    expect(
      sendIdx,
      "sendSetRootSubmitter call must exist in source"
    ).to.be.greaterThan(-1);
    expect(sendIdx).to.be.greaterThan(guardIdx);
  });

  it("52. wallet loading call site is in the yes path (after the else-block marker)", () => {
    const elseMark = "} else {";
    const walletLoad = join("read", "Keypair(walletPath");
    const elseIdx = src.indexOf(elseMark);
    const loadIdx = src.indexOf(walletLoad);
    if (loadIdx >= 0) {
      expect(loadIdx).to.be.greaterThan(
        elseIdx,
        "readKeypair(walletPath must appear after the else-block marker"
      );
    }
  });

  it("53. mainnet guard is present in source", () => {
    expect(src).to.include("mainnet");
  });

  it("54. script does not contain send-and-confirm tx helper", () => {
    expect(src).to.not.include(join("send", "And", "Confirm", "Transaction"));
  });

  it("55. validateIdlAddress exported and called in yes path after IDL load and before wallet loading", () => {
    // Positional ordering: IDL load < validateIdlAddress call < ANCHOR_WALLET
    // read < readKeypair call.  Cross-check error text must also be present.
    const callSite = "validateIdlAddress(idl)";
    const idlLoad = "const idl: any";
    const walletEnv = "process.env.ANCHOR_WALLET";
    const walletRead = join("read", "Keypair(walletPath");
    const crossCheck = "--program-id does not match IDL address";

    expect(src).to.include("export function validateIdlAddress");

    const callIdx = src.indexOf(callSite);
    expect(
      callIdx,
      "validateIdlAddress(idl) must exist in source"
    ).to.be.greaterThan(-1);

    const idlLoadIdx = src.indexOf(idlLoad);
    expect(
      callIdx,
      "validateIdlAddress(idl) must appear after IDL load"
    ).to.be.greaterThan(idlLoadIdx);

    const walletEnvIdx = src.indexOf(walletEnv);
    expect(
      callIdx,
      "validateIdlAddress(idl) must appear before ANCHOR_WALLET is read"
    ).to.be.lessThan(walletEnvIdx);

    const walletReadIdx = src.indexOf(walletRead);
    expect(
      callIdx,
      "validateIdlAddress(idl) must appear before readKeypair(walletPath)"
    ).to.be.lessThan(walletReadIdx);

    expect(src).to.include(crossCheck);
  });
});
