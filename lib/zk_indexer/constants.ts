// Domain tags — must match Phase 1/2 circuit and Rust light-poseidon parameters.
export const TAG_NULLIFIER = 1n;
export const TAG_LEAF = 2n;
export const TAG_NODE = 3n;
export const TAG_TX = 4n;
export const TAG_TX_INNER = 5n;

// Circuit version committed in tx_hash. Increment requires a full circuit re-keying.
export const CIRCUIT_VERSION = 1n;

// BN254 Fr modulus as 32-byte big-endian hex (no 0x prefix).
export const BN254_FR_MODULUS_HEX =
  "30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001";

// Merkle tree parameters — match NOTE_TREE_DEPTH in state.rs.
export const TREE_DEPTH = 20;
export const TREE_CAPACITY = 1 << TREE_DEPTH; // 1_048_576

// Empty subtree constants — generated from the accepted Phase 1/2 construction:
//   empty[0]   = Poseidon(TAG_LEAF, 0, 0)
//   empty[i+1] = Poseidon(TAG_NODE, empty[i], empty[i])
//
// All values are 32-byte big-endian BN254 Fr elements, lowercase hex, no 0x prefix.
// Cross-checked against known Phase 1/2 vectors: empty[0], empty[1], empty[20].
// Generated with circomlibjs 0.1.7 buildPoseidon().
export const EMPTY_SUBTREES: readonly string[] = [
  "1d4267ad68f74b8ab95b6f80c2de898227e7f33ad5d3634a644d0773d4ea85b8", // empty[0]
  "0992cf5b16b0e0abbed3ca9d67c877911bc1d668a40daa0c9a227a2744e23a71", // empty[1]
  "023f015257fd50dd8990fd7c3aacd4403ac394373642052619a73137470b2a79", // empty[2]
  "2d5e38e9120d2ef38e951a8a36ce6450f7fe618546d8ab2be07dbffd660fe8bc", // empty[3]
  "290d854557737ea3f121437df00e52c1a67ce30d118ab5890651fa18c0a0890b", // empty[4]
  "03dc88cd1058d04c761c7e4c1cab7d451688c154097f5ed066f3db09d58d2e47", // empty[5]
  "02474eb3a83f2c47287be0ccd86ac43d88d73b96f2947f342060116ba50c5905", // empty[6]
  "18fb3eb8f39670023190f47871853faadae9b2182ea3d1fe8f1d981ff4bf0417", // empty[7]
  "1fe786b1d76c76d05d6da433a7cdd77728de22db93d3a03c2236d512898d8a08", // empty[8]
  "2ca3f32cc782ef235fd5c9704aed06fa8eb81701dcab8306bc7736aeead3e92d", // empty[9]
  "1fd7c325062276a502c64b04a1dc02e1198c7171fc310185f60310ccc6c10a27", // empty[10]
  "139a296007daef6257443923edc4e0cc58ab370ade6015d94ec126974016e31e", // empty[11]
  "158604be5bcb944257fbec1794634f802f56e4ef2b43ef57fd2cc25822dd08c7", // empty[12]
  "29c2a2c0fd787a4267d47b024a8e6bde0de507ffad314ebc2c9eca8f42c85c8f", // empty[13]
  "0380839370918a85254803e0e9abd67d36409afcbadc4e324a345a3d98109d63", // empty[14]
  "045509be3d67ebbad7d9f0ed4406609498debf0f1ca38e796f160bc27b7aa6d3", // empty[15]
  "289e4224b277a1917e08400b0506f25b1d709da496f8e4c0f87c96477c350175", // empty[16]
  "19048373df023b78a36b93df51c7316638369527052dfa890c7af6407bc9c16b", // empty[17]
  "06d5ed2f90075a10ff9886120f4083f6002313af63543139dbc33febdc05f291", // empty[18]
  "2df2f48347eab992aa0b453828340992b87fb5c2b6f2a192fd3b42f05b0f9548", // empty[19]
  "08309ccafe9e331e3fc326a38fd73b32814d59314dde4a71ed629bd5e9067a25", // empty[20]
];
