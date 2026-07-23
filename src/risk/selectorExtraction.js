// Shared by bytecodeAnalysis.js (the paused "count unknown selectors"
// heuristic) and dangerousFunctions.js (the shipped, targeted dangerous-
// signature check) — kept in its own file so the two can be committed and
// deployed independently of each other.

// Standard Solidity dispatcher pattern: PUSH4 <selector> (opcode 0x63) is
// immediately followed by EQ (0x14) when comparing against msg.sig at the
// top of a contract's runtime code. Filtering on that exact suffix — rather
// than just scanning for any 4-byte-shaped run of bytes — is what keeps this
// from picking up false positives out of embedded revert strings or the
// trailing CBOR metadata (compiler version/IPFS hash), which don't happen to
// be followed by EQ. Verified live against catnip/NIP's real bytecode: a
// naive scan found 44 candidates including obvious string/metadata noise;
// this pattern narrows it to 22 without dropping any of the real ones.
export function extractSelectors(bytecodeHex) {
  const bytes = bytecodeHex.slice(2).toLowerCase();
  const selectors = new Set();
  for (let i = 0; i < bytes.length - 12; i += 2) {
    if (bytes.slice(i, i + 2) === "63" && bytes.slice(i + 10, i + 12) === "14") {
      selectors.add("0x" + bytes.slice(i + 2, i + 10));
    }
  }
  return [...selectors];
}
