const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const {
  isCCrew,
  ccrewAppName,
  CCREW_APP_NAME,
  CCREW_HOME_DIRNAME,
  CCREW_DEFAULT_PORT,
} = require("../ccrew-identity");
const { resolveHome, canonicalHome, secretCandidates } = require("../home-dir");

// A fake home so the CCrew data-home assertions are platform-independent: the
// resolvers build paths with path.join, so deriving the expectation the same way
// keeps the suite about the RULE (which dir name) rather than path syntax.
const HOME = path.resolve(path.sep, "mock", "home");
const fakeOs = { homedir: () => HOME };

describe("isCCrew", () => {
  it("is false with no marker and no env", () => {
    assert.equal(isCCrew({ env: {}, manifest: null }), false);
  });

  it("is true when the packaged manifest carries ccrew:true", () => {
    assert.equal(isCCrew({ env: {}, manifest: { ccrew: true } }), true);
  });

  it("is false when the manifest lacks the flag", () => {
    assert.equal(isCCrew({ env: {}, manifest: { name: "kirocrew-desktop" } }), false);
  });

  it("honors KIROCREW_CCREW=1 as a dev/test override", () => {
    assert.equal(isCCrew({ env: { KIROCREW_CCREW: "1" }, manifest: null }), true);
    assert.equal(isCCrew({ env: { KIROCREW_CCREW: "true" }, manifest: null }), true);
  });

  it("lets KIROCREW_CCREW=0 force off even when the manifest says true", () => {
    // The env is the explicit override, so a dev can run the KiroCrew identity
    // out of a CCrew checkout without repackaging.
    assert.equal(isCCrew({ env: { KIROCREW_CCREW: "0" }, manifest: { ccrew: true } }), false);
    assert.equal(isCCrew({ env: { KIROCREW_CCREW: "false" }, manifest: { ccrew: true } }), false);
  });
});

describe("ccrewAppName", () => {
  it("returns 'CCrew' for a CCrew build", () => {
    assert.equal(ccrewAppName({ env: { KIROCREW_CCREW: "1" }, manifest: null }), CCREW_APP_NAME);
    assert.equal(CCREW_APP_NAME, "CCrew");
  });

  it("returns null for a non-CCrew build, so main.js keeps its KiroCrew/nightly name", () => {
    assert.equal(ccrewAppName({ env: {}, manifest: null }), null);
  });
});

describe("home-dir CCrew edition", () => {
  it("canonicalHome is ~/.ccrew under the CCrew env", () => {
    assert.equal(
      canonicalHome(fakeOs, path, { KIROCREW_CCREW: "1" }),
      path.join(HOME, CCREW_HOME_DIRNAME),
    );
  });

  it("canonicalHome stays ~/.kiro/crew without the CCrew env", () => {
    assert.equal(canonicalHome(fakeOs, path, {}), path.join(HOME, ".kiro", "crew"));
  });

  it("resolveHome defaults to ~/.ccrew for CCrew", () => {
    assert.equal(
      resolveHome({ env: { KIROCREW_CCREW: "1" }, os: fakeOs, path }),
      path.join(HOME, CCREW_HOME_DIRNAME),
    );
  });

  it("an explicit KIROCREW_HOME override still wins over the CCrew default", () => {
    const override = path.resolve(path.sep, "custom", "home");
    assert.equal(
      resolveHome({ env: { KIROCREW_CCREW: "1", KIROCREW_HOME: override }, os: fakeOs, path }),
      override,
    );
  });

  it("secretCandidates points .local_secret at ~/.ccrew for CCrew", () => {
    assert.deepEqual(
      secretCandidates({ env: { KIROCREW_CCREW: "1" }, os: fakeOs, path }),
      [path.join(HOME, CCREW_HOME_DIRNAME, ".local_secret")],
    );
  });
});

describe("CCrew constants", () => {
  it("pins the port to 5490 (side-by-side with KiroCrew's 5476)", () => {
    assert.equal(CCREW_DEFAULT_PORT, 5490);
  });
});

const fs = require("fs");

describe("main.js identity pinning (CCrew vs KiroCrew coexistence)", () => {
  // Electron caches userData (and thus the single-instance lock key) on the
  // FIRST app.getPath("userData") call, deriving the path from app.getName(),
  // which reads the packaged package.json "name" (kirocrew-desktop) -- NOT
  // CFBundleName. Assigning app.name later does NOT repoint an already-resolved
  // userData path, so a late rename left CCrew sharing KiroCrew's
  // kirocrew-desktop userData and losing the single-instance lock to a running
  // KiroCrew (macOS fronted KiroCrew instead of opening CCrew).
  //
  // The fix pins BOTH the name (app.setName) and the userData path
  // (app.setPath("userData", ...)) at the very top of main.js, before any other
  // resolver runs. This test locks that ordering and the use of setPath, since
  // setName alone cannot repoint an already-cached path. Line comments are
  // stripped before searching so prose mentioning these calls cannot skew the
  // positions.
  it("pins CCrew name and userData path before the first app.getPath(\"userData\") call", () => {
    const raw = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
    // Blank out // line comments (preserving length so indices still line up
    // with the source) so a comment mentioning getPath("userData") cannot be
    // mistaken for the real call site.
    const code = raw.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));

    const setNameIdx = code.indexOf("app.setName(");
    const setUserDataIdx = code.indexOf('app.setPath(');
    const firstUserDataGet = code.indexOf('app.getPath("userData")');

    assert.ok(
      setNameIdx !== -1,
      "expected app.setName(...) pinning the CCrew name in main.js",
    );
    assert.ok(
      setUserDataIdx !== -1,
      'expected app.setPath("userData", ...) pinning the CCrew userData path in main.js',
    );
    assert.ok(
      firstUserDataGet !== -1,
      'expected an app.getPath("userData") call in main.js',
    );

    // The setPath("userData") pin, and the setName, must both precede the first
    // app.getPath("userData") (the seedRenamedStore call) that Electron would
    // otherwise cache under the default kirocrew-desktop name.
    assert.ok(
      setUserDataIdx < firstUserDataGet,
      'app.setPath("userData", ...) must run BEFORE the first ' +
        'app.getPath("userData") so CCrew keys off its own userData dir, not the ' +
        "default kirocrew-desktop shared with a running KiroCrew",
    );
    assert.ok(
      setNameIdx < firstUserDataGet,
      "app.setName(...) must run before the first app.getPath(\"userData\")",
    );

    // Confirm the setPath pin actually targets the userData path (not some
    // other Electron path), tolerating single- or multi-line formatting.
    const pinTail = code.slice(setUserDataIdx, setUserDataIdx + 60);
    assert.ok(
      /app\.setPath\(\s*"userData"/.test(pinTail),
      'the app.setPath(...) pin must target "userData"',
    );
  });
});
