/**
 * How Atrium is packaged for download.
 *
 * This is JavaScript rather than the usual YAML for one reason: the build has
 * to come out correct both with and without an Apple Developer certificate,
 * and those two paths need genuinely different settings — not just a different
 * identity. Notarization requires the hardened runtime, the hardened runtime
 * requires entitlements, and turning either on without a real certificate
 * produces a bundle that is worse than not signing at all.
 *
 * So: `signed` is inferred from the environment, and adding the certificate
 * secrets to the repo is the *only* thing needed to switch a release from
 * "unidentified developer" to no warning at all. Nothing here changes.
 */

/** A certificate is present, so this build can be signed for real. */
const signed = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);
/** ...and Apple credentials are present, so it can also be notarized. */
const notarizing = signed && Boolean(process.env.APPLE_TEAM_ID && process.env.APPLE_ID);

module.exports = {
  appId: 'dev.masonchoi.atrium',
  productName: 'Atrium',
  copyright: 'Mason Choi',

  directories: {
    output: 'dist',
    buildResources: 'resources',
  },

  files: ['out/**', 'resources/**', 'package.json'],

  mac: {
    // One download that runs natively on both Apple Silicon and Intel, so
    // there is nothing for someone to get wrong before the app has even
    // started. It costs about 110MB over a single-architecture build.
    target: [{ target: 'dmg', arch: ['universal'] }],
    category: 'public.app-category.developer-tools',
    icon: 'resources/icon.icns',
    darkModeSupport: true,

    /*
     * Ad-hoc signing is not a formality — it is the difference between two
     * completely different first-launch experiences.
     *
     * With no signature at all, macOS cannot validate the bundle and reports
     * "Atrium is damaged and can't be opened. You should move it to the Trash",
     * which looks exactly like malware and gives the user nowhere to go. An
     * ad-hoc signature seals the bundle and binds its Info.plist, so the app is
     * merely *unidentified* — the ordinary "Open Anyway" flow, once, per
     * machine. Same amount of trust, vastly better failure mode.
     *
     * `undefined` (not null) lets electron-builder pick up the real certificate
     * from CSC_LINK when there is one; `null` would disable signing outright.
     */
    identity: signed ? undefined : '-',

    // Both of these are meaningless without a real certificate, and actively
    // harmful with an ad-hoc one: a hardened runtime that Apple has not blessed
    // just adds ways for the app to be killed on launch.
    hardenedRuntime: signed,
    ...(signed ? { entitlements: 'build/entitlements.mac.plist', entitlementsInherit: 'build/entitlements.mac.plist' } : {}),

    // Asking Gatekeeper to assess a build we already know is unsigned only
    // fails the build on the packaging machine. It says nothing about what a
    // user will see, which depends on the quarantine flag, not on this.
    gatekeeperAssess: false,

    notarize: notarizing ? { teamId: process.env.APPLE_TEAM_ID } : false,

    extendInfo: {
      // No camera, microphone, location or contacts: there is nothing to
      // declare, because the app never asks for anything it does not read.
      LSApplicationCategoryType: 'public.app-category.developer-tools',
      NSHighResolutionCapable: true,
    },
  },

  dmg: {
    title: 'Atrium',
    // One asset per release, named so it is obvious what it is sitting in a
    // Downloads folder six weeks later. No `-universal` suffix: there is only
    // one build, and the suffix reads like a choice the user has to make.
    artifactName: 'Atrium-${version}.dmg',
    // The whole install: two icons and an arrow's worth of implication.
    contents: [
      { x: 140, y: 190, type: 'file' },
      { x: 400, y: 190, type: 'link', path: '/Applications' },
    ],
  },

  // electron-builder rebuilds native modules by default; there are none here,
  // and skipping it keeps a package under a minute.
  npmRebuild: false,
};
