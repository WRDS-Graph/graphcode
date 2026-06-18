/**
 * Unit tests for impact-ranker v2 (no external deps; run with `node`).
 * Locks in the THREE structural behaviors that make v2 a real, held-out-validated
 * improvement over v1 (0.386 → 0.511 held-out F1):
 *   1. test/mock/dummy files are demoted below all real candidates
 *   2. raw reference DENSITY is the primary within-class signal (no cap)
 *   3. the 1-hop direct-caller bonus is ADDITIVE (cannot bury a far-denser
 *      production dependent — the bug that tanked I1 Resource when callers ⊥ gold)
 */
import { rankImpact, basename, isTestFile } from "./impact-ranker-v2.mjs";

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass += 1; } else { fail += 1; console.error("FAIL:", msg); }
}

// --- basename normalization ---
assert(basename("a/b/Foo.java") === "foo", "basename strips dir + .java + lowercases");

// --- test-file detection (structural, JVM/Maven conventions) ---
assert(isTestFile("x/src/test/java/com/Foo.java") === true, "files under /test/ are tests");
assert(isTestFile("x/TestServer.java") === true, "Test* prefix is a test");
assert(isTestFile("x/ServerTest.java") === true, "*Test suffix is a test");
assert(isTestFile("x/DummyHAService.java") === true, "Dummy* prefix is a test");
assert(isTestFile("x/MockClient.java") === true, "Mock* prefix is a test");
assert(isTestFile("x/ITestAbfs.java") === true, "ITest* prefix is a test");
assert(isTestFile("x/src/main/java/com/Server.java") === false, "production file is not a test");
assert(isTestFile("x/Resources.java") === false, "Resources (plural, not *Test) is not a test");

// --- fixture ---
const subjectFile = "proj/src/main/com/x/sub/Subject.java";
const impactJson = {
  affected: [
    { filePath: "proj/src/main/com/x/sub/Subject.java", name: "Subject" }, // subject (excluded)
    // a very-dense PRODUCTION dependent that is NOT a direct caller (the I1/Resource shape)
    ...Array.from({ length: 30 }, (_, i) => ({ filePath: "proj/src/main/com/x/far/DenseProd.java", name: `m${i}` })),
    // a low-density file that IS a direct caller (the wrong-caller shape)
    { filePath: "proj/src/main/com/x/dir/LowDirect.java", name: "d1" },
    // a high-density TEST file (the Server/TestIPC shape) — must be demoted
    ...Array.from({ length: 50 }, (_, i) => ({ filePath: "proj/src/test/com/x/TestHub.java", name: `t${i}` })),
    // a same-package modest file
    { filePath: "proj/src/main/com/x/sub/Sibling.java", name: "s1" },
  ],
};
const callersJson = { callers: [{ filePath: "proj/src/main/com/x/dir/LowDirect.java" }] };
const ranked = rankImpact({ impactJson, callersJson, subjectFile, anchor: "Subject" });
const by = (b) => ranked.find((r) => r.basename === b);

// 1. subject excluded
assert(!ranked.some((r) => r.basename === "subject"), "subject file excluded");

// 2. test file demoted below ALL real candidates despite highest density (50 refs)
const testHub = by("testhub");
const denseProd = by("denseprod");
assert(testHub && testHub.isTest === true && testHub.tier === "test", "TestHub flagged as test tier");
assert(testHub && denseProd && denseProd.score > testHub.score, "dense TEST file demoted below real dependents");
assert(ranked[ranked.length - 1].isTest === true, "a test file sorts to the bottom");

// 3. additive direct bonus: a far-denser production dependent (30 refs) still outranks a
//    low-density direct caller (1 ref + direct bonus) — the I1 fix.
const lowDirect = by("lowdirect");
assert(lowDirect && lowDirect.direct === true, "LowDirect flagged as direct caller");
assert(denseProd.score > lowDirect.score, "very-dense production dependent outranks low-density direct caller (I1 fix)");

// but a direct caller DOES beat a same-density non-caller (the bonus still helps when density ties)
//   Sibling: same-pkg(+4), 1 ref; LowDirect: direct(+8), 1 ref  → LowDirect wins
const sibling = by("sibling");
assert(lowDirect.score > sibling.score, "direct caller beats same-density same-package non-caller");

// 4. name-match: a low-density file whose basename contains the anchor word (implementor
//    convention) is surfaced — the only signal that reaches 2-hop low-density gold (Clock fix).
{
  const impJ = { affected: [
    { filePath: "p/src/main/com/x/sub/Subject.java", name: "Subject" },
    { filePath: "p/src/main/com/y/MonotonicSubject.java", name: "g1" }, // 1 ref, name-matches "subject"
    { filePath: "p/src/main/com/y/Unrelated.java", name: "u1" },        // 1 ref, no match
  ] };
  const r = rankImpact({ impactJson: impJ, callersJson: { callers: [] }, subjectFile, anchor: "Subject" });
  const monotonic = r.find((x) => x.basename === "monotonicsubject");
  const unrelated = r.find((x) => x.basename === "unrelated");
  assert(monotonic && monotonic.nameMatch === true, "MonotonicSubject flagged as name-match (implementor)");
  assert(monotonic.score > unrelated.score, "name-matching implementor outranks equal-density non-match");
  // short anchors must NOT over-fire
  const rShort = rankImpact({ impactJson: impJ, callersJson: { callers: [] }, subjectFile, anchor: "Id" });
  assert(rShort.every((x) => x.nameMatch === false), "short anchor (<4 chars) does not trigger name-match");
}

// density is primary & uncapped: denseProd (30 refs) leads the real candidates
const realLeader = ranked.find((r) => !r.isTest);
assert(realLeader.basename === "denseprod", "highest-density real file leads (density uncapped & primary)");

// sorted desc, null-safe
for (let i = 1; i < ranked.length; i++) assert(ranked[i - 1].score >= ranked[i].score, "sorted desc");
assert(rankImpact({ impactJson: null, callersJson: null, subjectFile, anchor: "X" }).length === 0, "null → empty, no throw");

console.log(`\nimpact-ranker-v2 tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
