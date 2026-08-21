'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

/**
 * Ad-hoc sign the packaged app.
 *
 * Sludge is not distributed with an Apple Developer certificate, so macOS will
 * quarantine it either way. But electron-builder's own ad-hoc signature came
 * out inconsistent with the bundle — Gatekeeper reported "code has no resources
 * but signature indicates they must be present" — which is a harder rejection
 * than plain unsigned. Signing here, after everything is in place, keeps the
 * signature and the contents in agreement.
 */
exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'pipe' });
    execFileSync('codesign', ['--verify', appPath], { stdio: 'pipe' });
    console.log(`  • ad-hoc signed ${path.basename(appPath)}`);
  } catch (err) {
    // A failed ad-hoc signature is not worth failing the build over.
    console.warn(`  • ad-hoc signing skipped: ${err.message}`);
  }
};
