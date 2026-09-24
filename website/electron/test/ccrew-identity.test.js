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
