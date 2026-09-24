"use strict";

// ccrew-identity.js — the CCrew edition's desktop identity, in one place.
//
// CCrew is the standalone (public) fork packaged as its OWN macOS app
// ("CCrew.app", bundle id com.ccrew.app). Its whole reason to exist is to run
// SIDE BY SIDE with an installed upstream KiroCrew.app — so it must not collide
// with KiroCrew on any of the three axes macOS/Electron use to decide "is this
// the same app already running?":
//
//   1. app.name — Electron keys requestSingleInstanceLock() and the userData
//      directory off app.name. If CCrew keeps "Kiro Crew", its single-instance
//      lock is the SAME lock KiroCrew holds, so launching CCrew.app while
//      KiroCrew runs loses the lock and macOS just fronts the running KiroCrew
//      (the exact "double-click opens the other app" bug this module fixes).
//   2. data home — the gateway's config/session store. KiroCrew uses
//      ~/.kiro/crew; CCrew uses ~/.ccrew (mirroring ccrew.sh) so the two never
//      share config.json, .local_secret, or history.
//   3. gateway port — KiroCrew defaults to 5476; CCrew defaults to 5490
//      (mirroring ccrew.sh) so both gateways can bind at once.
//
// DETECTION is build-time, not runtime env: a double-clicked .app inherits no
// shell env, so CCREW=1 in build-desktop.sh bakes `"ccrew": true` into the
// packaged app/package.json via electron-builder's extraMetadata. At runtime we
// read that manifest flag. A KIROCREW_CCREW=1 env override exists purely so a
// dev source run (or a test) can exercise the CCrew identity without packaging.
//
// A plain source run or a hypothetical upstream desktop build has neither the
// baked flag nor the env, so it keeps every KiroCrew default untouched — this is
// additive, not a rewrite of the shared identity path.

const CCREW_APP_NAME = "CCrew";
const CCREW_HOME_DIRNAME = ".ccrew";
const CCREW_DEFAULT_PORT = 5490;

/**
 * Is this desktop shell the CCrew edition?
 *
 * @param {object}  [deps]
 * @param {NodeJS.ProcessEnv} [deps.env]      defaults to process.env
 * @param {object|null}       [deps.manifest] the app's own package.json; when
 *        omitted it is require()'d lazily so a caller need not pass it. `null`
 *        is honored (used by tests to assert the env-only path).
 * @returns {boolean}
 */
function isCCrew({ env = process.env, manifest } = {}) {
  // Env override wins — lets a dev `KIROCREW_CCREW=1 ./run` and the test suite
  // exercise the CCrew identity without a packaged manifest.
  const raw = env.KIROCREW_CCREW;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;

  let pkg = manifest;
  if (pkg === undefined) {
    try {
      pkg = require("./package.json");
    } catch {
      pkg = null;
    }
  }
  return Boolean(pkg && pkg.ccrew === true);
}

/**
 * The app.name for this edition: "CCrew" for CCrew, else null so the caller
 * keeps its existing KiroCrew/nightly naming untouched.
 * @returns {string|null}
 */
function ccrewAppName(deps) {
  return isCCrew(deps) ? CCREW_APP_NAME : null;
}

/**
 * The CCrew data-home directory name (".ccrew"), joined under the user's home
 * by the caller. Exported as a constant so home-dir.js stays the single place
 * that knows how to build a home path.
 */
module.exports = {
  isCCrew,
  ccrewAppName,
  CCREW_APP_NAME,
  CCREW_HOME_DIRNAME,
  CCREW_DEFAULT_PORT,
};
