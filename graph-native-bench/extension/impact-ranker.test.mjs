/**
 * Unit tests for the graph-native impact ranker (no external deps; run with `node`).
 * Verifies the ranking SIGNAL combination, subject-file exclusion, and the
 * direct-caller / package-locality bonuses — the behaviors that make the ranker a
 * real capability rather than a firehose paste.
 */
import { rankImpact, basename } from "./impact-ranker.mjs";

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass += 1; } else { fail += 1; console.error("FAIL:", msg); }
}

// --- basename normalization ---
assert(basename("a/b/Foo.java") === "foo", "basename strips dir + .java + lowercases");
assert(basename("Bar.JAVA".replace(".JAVA", ".java")) === "bar", "basename lowercases");

// --- fixture: anchor Subject in pkg/sub; gold-ish neighbors + a far firehose file ---
const subjectFile = "proj/src/com/x/sub/Subject.java";
const impactJson = {
  affected: [
    { filePath: "proj/src/com/x/sub/Subject.java", name: "Subject" },     // subject itself (excluded)
    { filePath: "proj/src/com/x/sub/Neighbor.java", name: "m1" },          // same pkg, 1 ref
    { filePath: "proj/src/com/x/sub/Neighbor.java", name: "m2" },          // same pkg, 2nd ref
    { filePath: "proj/src/com/x/other/Far.java", name: "f1" },             // diff pkg, 1 ref
    { filePath: "proj/src/com/x/other/Far.java", name: "f2" },             // diff pkg, 2nd ref
    { filePath: "proj/src/com/x/other/Far.java", name: "f3" },             // diff pkg, 3rd ref (high density)
    { filePath: "proj/src/com/x/dir/DirectOnly.java", name: "d1" },        // diff pkg, 1 ref, but direct caller
  ],
};
const callersJson = { callers: [{ filePath: "proj/src/com/x/dir/DirectOnly.java" }] };

const ranked = rankImpact({ impactJson, callersJson, subjectFile, anchor: "Subject" });

// subject's own file excluded
assert(!ranked.some((r) => r.basename === "subject"), "subject file is excluded from ranking");

// Neighbor: same pkg (+20) + 2 refs = 22  → should outrank Far (3 refs, diff pkg = 3)
const neighbor = ranked.find((r) => r.basename === "neighbor");
const far = ranked.find((r) => r.basename === "far");
const directOnly = ranked.find((r) => r.basename === "directonly");
assert(neighbor && far && neighbor.score > far.score, "same-package file outranks higher-density far file");

// DirectOnly: direct caller (+5) + 1 ref = 6 → outranks Far(3) despite lower density
assert(directOnly && far && directOnly.score > far.score, "direct caller outranks non-caller of higher density");

// ranking is sorted descending by score
for (let i = 1; i < ranked.length; i++) {
  assert(ranked[i - 1].score >= ranked[i].score, "ranked output is sorted by score desc");
}

// flags populated correctly
assert(neighbor.samePkg === true && neighbor.refs === 2, "neighbor flags: samePkg, refs=2");
assert(directOnly.direct === true, "directOnly flagged as direct caller");

// empty / null inputs don't throw
assert(rankImpact({ impactJson: null, callersJson: null, subjectFile, anchor: "X" }).length === 0, "null json → empty ranking, no throw");

console.log(`\nimpact-ranker tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
