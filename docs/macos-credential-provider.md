# macOS credential provider: system AutoFill for the desktop app

Plan for shipping an `ASCredentialProviderExtension` inside the macOS desktop app, so Bramble
appears in **System Settings > General > AutoFill & Passwords**, under both **AutoFill from** and
**Set Up Codes In**, and fills passwords, passkeys and one-time codes into Safari and native Mac
apps. Tracks [#61](https://github.com/bramble-sh/bramble/issues/61).

Three classes of claim live here. **Codebase findings are verified** and carry file paths.
**Apple API and policy claims** were checked against live sources on 2026-08-27 and carry a link.
**Toolchain claims about Tauri** were read out of the bundler source on 2026-09-03 and carry a
file and line. **Everything else was observed on a real machine on 2026-09-03**, by shipping a stub
extension through the real build and filling a field in Safari with it; see
[What iteration 0 proved](#what-iteration-0-proved). Nothing load-bearing is unverified any more.

## Bottom line

- **It replaces the reason auto-type existed, on macOS.** `desktop-port.md` lists auto-type
  (synthesized keystrokes plus an Accessibility permission) as the way to fill windows that are not
  a browser. The credential provider does that through a supported API, with no Accessibility
  prompt and no key synthesis. What auto-type would still buy is Electron apps, which participate
  in neither. That is not a small set (Slack, Discord, Spotify, VS Code, Notion), so treat
  "auto-type is obsolete" as a decision to make later with usage data, not a conclusion.
- **Safari comes free.** Password AutoFill in Safari is served by whatever provider the user
  designates, so this closes the Safari gap without writing, reviewing or maintaining a Safari
  extension. Combined with the existing Chromium and Firefox extension, browser coverage becomes
  complete except for Electron apps.
- **Most of the extension is already written, for iOS, including the parts that look like later
  phases.** `clients/mobile/ios/App/AutoFillProbe/CredentialProviderViewController.swift`
  is the same framework, the same auth-first design, and the same `VaultCryptoFFI` core. It already
  implements passwords, one-time codes, and passkey get *and* create, all device-verified. See
  [What is reused as-is](#what-is-reused-as-is).
- **Developer ID distribution is fine**, which was the risk worth checking first. See
  [Signing and distribution](#signing-and-distribution).
- **Packaging is answered and cheaper than planned.** Tauri has a config-level seam for this; no
  new build stage between the bundler and the `.dmg`. See
  [Getting an `.appex` into a Tauri bundle](#getting-an-appex-into-a-tauri-bundle).
- **Entitlements are done, and were the last thing that could have killed the plan.** The App IDs,
  capabilities and Developer ID profiles exist, and `codesign` accepts them on a nested `.appex`.
  See [Signing and distribution](#signing-and-distribution).
- **The genuinely new work left is the shared container**, not product code, not the build script,
  and no longer the Apple account.
- **One blocker, found 2026-11-15: Bramble must never answer its own unlock.** Chrome and Firefox
  route passkeys through the macOS system sheet, so the extension's Touch ID key (rpID
  `bramble.sh`) could be saved into Bramble, or arrive there by importing from Apple Passwords. The
  fix is a reserved-rpID guard plus a Touch ID key the desktop holds for the extension. See
  [Blocker](#blocker-bramble-answering-its-own-unlock).
- **One thing it will not do: capture new passwords.** There is no save hook. See
  [The save gap](#the-save-gap).

## What one extension target buys

All of it hangs off `ASCredentialProviderViewController`
([docs](https://developer.apple.com/documentation/authenticationservices/ascredentialproviderviewcontroller),
macOS 11.0+; the user-facing designation in System Settings is macOS 13 or later per
[Apple Platform Security](https://support.apple.com/guide/security/credential-provider-extensions-sec6319ac7b9/web)).

| Capability | Entry point | Floor |
|---|---|---|
| Password fill, full picker | `prepareCredentialList(for:)` | macOS 11 |
| Password fill, no UI (QuickType) | `provideCredentialWithoutUserInteraction(for:)` + `ASCredentialIdentityStore` | macOS 11 |
| Passkey sign-in | `ASPasskeyCredentialRequest` | macOS 14 |
| Passkey **registration** | `prepareInterface(forPasskeyRegistration:)` | macOS 14 |
| One-time codes | `prepareOneTimeCodeCredentialList(for:)`, `ASOneTimeCodeCredentialIdentity` | macOS 15 |
| Listed under **Set Up Codes In** | The **app's** `otpauth` URL scheme, not this extension ([totp-uri-handler.md](totp-uri-handler.md), Phase 4) | macOS 15 |
| Arbitrary text insertion | `prepareInterfaceForUserChoosingTextToInsert()` | macOS 14 |
| Site-driven credential updates | `ASCredentialUpdater` report methods | macOS 15 |

Passkey registration is the one to notice: it is a *write* path the OS hands us, so a passkey
created in Safari lands in the vault. That makes this a delivery vehicle for
[passkey-provider.md](passkey-provider.md) on macOS, not a separate initiative.

`ASCredentialProviderViewController` inherits `NSViewController` on macOS and `UIViewController` on
iOS, so the container is per-platform even though the SwiftUI inside it is not. Apple's own note:
"This class ignores calls from Mac apps built with Mac Catalyst." Not our situation (the desktop app
is Tauri, so AppKit), but it rules out the shortcut of Catalyst-ing the iOS app.

## Where it does and does not fill

Worth stating precisely, because "native apps" is not one thing and the passkey answer is broader
than the password answer.

- **Safari.** Passwords, passkeys and one-time codes, with no cooperation needed from the site.
- **Native apps, passwords and codes.** Only where the developer opted in by setting `contentType`
  on the field (`NSTextField` with `.username`, `NSSecureTextField` with `.password`, `NSTextField`
  with `.oneTimeCode`, or the SwiftUI `.textContentType` modifier). Apps that never set it get
  nothing, from us or from Apple's own Passwords app.
  [Password AutoFill](https://developer.apple.com/documentation/security/password-autofill).
- **Native apps, passkeys.** No per-field adoption needed. Any app driving
  `ASAuthorizationController` reaches the designated provider on macOS 14+. So passkey coverage in
  native apps is strictly wider than password coverage.
- **Chrome and Firefox: passkeys yes, passwords and codes no.** Their own autofill never asks a
  system provider, so password and code fill there stays with our browser extension
  ([bitwarden/clients#20743](https://github.com/bitwarden/clients/issues/20743)). Their WebAuthn
  is different: on macOS 14+ a platform passkey request goes through Apple's system sheet, which
  includes enabled third-party providers, so Bramble's passkeys answer there too whenever our
  extension's own Chrome passkey provider is not intercepting first. That includes our extension's
  own unlock, which is [the blocker](#blocker-bramble-answering-its-own-unlock).
- **Electron apps: no.** They draw their own text fields and participate in neither mechanism.
  This is the only real hole once both ship.

The old version of this doc concluded that designating Bramble changes nothing about the browser
extension's WebAuthn PRF unlock. That was wrong; see
[the blocker](#blocker-bramble-answering-its-own-unlock).

## The save gap

**There is no API for a third party to receive a newly typed password.** Checked deliberately,
because it decides how complete the Safari win is:

- Passkey creation has a hook (`prepareInterface(forPasskeyRegistration:)`).
- Passwords have none. Safari offers to save to Apple's Passwords app, not to us.
- The 27 SDK adds nothing here; its AuthenticationServices additions are verification codes
  (`ASVerificationCode`, `DeliveredVerificationCodesManager`) and federated identity
  ([summary](https://miniswift.run/whats-new/authenticationservices/)).

So on Safari, a new login is added by hand in the app. The Chromium and Firefox extension keeps its
corner-prompt capture, so this asymmetry is Safari-only, and it is the one honest argument left for
also having a Safari extension one day. Not a reason to delay this.

## What is reused as-is

- **The extension's logic, including codes and passkeys.**
  `CredentialProviderViewController.swift` already implements the model this needs: authenticate first, then decrypt. It shows an unlock screen and only then decrypts the
  credential list, so nothing about the vault is readable before the user authenticates. That
  property is worth more on macOS, where the extension's container is on a disk shared with
  everything else the user runs. Specifically already present:
  - **One-time codes:** `prepareOneTimeCodeCredentialList`, `ASOneTimeCodeCredentialRequest`
    handling, `completeOneTimeCode`, the list filtered to entries that actually carry a TOTP, and
    `ASOneTimeCodeCredentialIdentity` registration in `ios/App/App/AutofillBridge.swift`.
  - **Passkeys:** assertion, registration via `prepareInterface(forPasskeyRegistration:)`, and
    `ASPasskeyCredentialIdentity` registration. Device-verified on iOS: register and sign-in on
    webauthn.io both succeed (see [passkey-provider.md](passkey-provider.md)).
  - **PRF:** a create that asks for PRF answers it, and a sign-in evaluates the credential's stored
    secrets (iOS 18+, `500c03c2`; [passkey-prf.md](passkey-prf.md)). This matters for
    [the self-unlock blocker](#blocker-bramble-answering-its-own-unlock): it is what removed the
    last accidental protection.
- **The UI, almost entirely.** The controller is effectively pure SwiftUI. Its whole UIKit surface
  is one `UIHostingController` and two `UIImage`. The port is `NSHostingController` and `NSImage`
  plus the `NSViewController` host, not a rewrite.
- **The crypto.** The extension calls the shared Rust core through uniffi (`VaultCryptoFFI`),
  including the native Argon2id master-password path and the passkey primitives
  (`packages/core-rust/src/passkey.rs`, exposed on both the wasm and the uniffi layers in `lib.rs`).
  `packages/core-rust` already builds for macOS: the Tauri app links it as a plain cargo dependency
  under the `native` feature. What is new is producing *Swift* bindings for macOS targets, which is
  additive to the existing `ffi` feature and to `scripts/build-crypto-ffi.sh` (a `macos` subcommand
  beside `ios` and `android`, universal, since the release `.dmg` is universal).
- **The bundle format.** The encrypted-at-rest credential bundle the iOS app writes for its
  extension is the shape the desktop app should write too, and it already carries passkeys. Same
  producer logic, different location.
- **The entitlement layout.** `AutoFillProbe.entitlements` already declares
  `com.apple.developer.authentication-services.autofill-credential-provider`, an App Group, and a
  keychain access group. Apple's integration steps say to add the entitlement "to **both** the
  extension and its containing app", which is the same lesson that cost a debugging cycle on iOS.

## What is new

### Signing and distribution

The desktop app is Developer ID signed and notarized (`scripts/build-macos.ts`, and
`scripts/release.ts` refuses to publish an un-notarized build), distributed as a `.dmg` and a
Homebrew cask. Not the Mac App Store. That is the constraint everything here has to survive.

**It survives.** Xcode has long emitted "The AutoFill Credential Provider capability is not
available for Developer ID provisioning profiles", which reads like a policy wall. An Apple DTS
engineer's answer on [forum thread 690381](https://developer.apple.com/forums/thread/690381) is that
this is an *automatic signing* defect: the capability is listed as supported for Developer ID on
macOS, a Developer ID profile carrying the entitlement can be created manually, and the workaround
is manual signing. Precedent, as of mid-2026: 1Password (beta) and Strongbox both ship macOS
credential providers.

**Confirmed end to end on 2026-09-03, not just per the forum thread.** The account was bare when
this started: team `BHGR3PP64J` had no macOS bundle IDs and no Developer ID profiles at all.
Since then desktop Touch ID unlock (`8b135a8f`) made every signed release carry a restricted
entitlement and embed the app profile below, so the app-side half of this is already in
production. The signing identity comes
from `APPLE_SIGNING_IDENTITY` in `.env.local`, against `Developer ID Application: Webvana Inc.
(BHGR3PP64J)`, certificate `85Y6Y7ZV23`. All of the following was then created through the App
Store Connect API and verified locally:

| Thing | Identifier | ASC id |
|---|---|---|
| App App ID | `app.bramble.desktop` | `93TVPM6A28` |
| Extension App ID | `app.bramble.desktop.autofill` | `F79J537QHC` |
| App Developer ID profile | Bramble Desktop Developer ID | `ZTUGGVNS58` |
| Extension Developer ID profile | Bramble Desktop AutoFill Developer ID | `7VRU3S4KM5` |

- **`AUTOFILL_CREDENTIAL_PROVIDER` and `APP_GROUPS` are settable on a macOS App ID** through
  `POST /v1/bundleIdCapabilities`. Apple normalises the platform to `UNIVERSAL`, same as the
  existing mobile App IDs.
- **A `MAC_APP_DIRECT` (Developer ID) profile carrying the capability creates and goes `ACTIVE`.**
  This is the claim the whole plan rested on, and it is now observed rather than inferred. Xcode's
  "not available for Developer ID provisioning profiles" really is an automatic-signing defect.
- **The profile grants app groups and keychain groups by wildcard**: `BHGR3PP64J.*` for both. So
  **no App Group needs registering** in the portal, which removes a step the plan assumed. Decoded
  profile entitlements are exactly `application-identifier`, `team-identifier`,
  `authentication-services.autofill-credential-provider: true`, `application-groups: [BHGR3PP64J.*]`
  and `keychain-access-groups: [BHGR3PP64J.*]`. `KEYCHAIN_SHARING` is not a portal capability at
  all; the wildcard is where it comes from.
- **`codesign` accepts the restricted entitlements** against the Developer ID identity with the
  profile embedded. Verified on a stub `.app` carrying a stub `.appex` in `Contents/PlugIns/`,
  signed inside out with per-target entitlements, universal (`x86_64 arm64`), hardened runtime on
  (`flags=0x10000(runtime)`). Reading the signature back with `codesign -d --entitlements` shows
  the entitlements sealed on both, with the concrete group names rather than the wildcards.
  `codesign -vvv --deep --strict` reports the nested appex prepared and validated, "valid on disk",
  "satisfies its Designated Requirement".

The identifiers this picked, following the iOS convention (`group.app.bramble.mobile`,
`app.bramble.mobile.shared`):

- App Group: `BHGR3PP64J.group.app.bramble.desktop`
- Keychain access group: `BHGR3PP64J.app.bramble.desktop.shared`

Note the team-ID prefix is real on macOS and is not written as `$(AppIdentifierPrefix)` the way the
iOS entitlements do it. Read it back with `codesign -d --entitlements` rather than trusting either
form, which is the lesson the iOS keychain group already taught once.

- **Notarization accepts it.** The same stub, zipped and submitted to the notary service, came
  back `Accepted` (submission `84099fb7-03dc-449b-99bc-af1ada6ee932`). So the entitlements survive
  the whole chain: capability, profile, codesign, notarization.

**New operational cost:** the app has never had a provisioning profile, so nothing about the macOS
release currently expires. After this, stale signing material becomes a way for a release to break,
and it is not the obvious date that matters. A Developer ID profile carries an 18-year TTL of its
own (`TimeToLive` 6570, so these claim 2044-08-30); what actually kills it is the certificate in
its `DeveloperCertificates`, expiring 2027-02-01, which is also what App Store Connect reports as
the profile's expiry. Renewing the certificate invalidates the profiles too, since they still list
the old one, and that failure is indistinguishable from expiry at the point it bites.
`scripts/build-macos.ts` now checks both before every macOS build and refuses an expired one; see
[release-signing.md](release-signing.md). **As of 2026-11-15 that certificate has 78 days left**,
and renewing it means regenerating both profiles and the two CI secrets.

### Getting an `.appex` into a Tauri bundle

This was the plan's main `[unverified]`, on the assumption that a new stage had to be wedged
between Tauri's bundle step and the `.dmg`. **Not needed.** Read against tauri-bundler 2.7.0 and
tauri-macos-sign 2.1.0 on 2026-09-03 (the CLI is pinned at `^2.11.4`, so re-read if it moves):

- **`bundle.macOS.files`** maps `Contents`-relative destinations to sources, and
  `copy_custom_files_to_bundle` handles directories via `copy_dir`
  (`src/bundle/macos/app.rs:179-205`). A `.appex` is a directory bundle, so it goes in as config.
  The same mechanism drops `embedded.provisionprofile` into `Contents/`.
- **The ordering already works.** Custom files are copied at `app.rs:109`, before signing at
  `:111-128`. The app bundle is pushed *last* into `sign_paths`, under the comment "per apple,
  signing must be done inside out".
- **Custom files are never added to `sign_paths`.** So a `.appex` that arrives already signed is
  left untouched and then sealed by the outer app signature. That is exactly the inside-out order
  Apple wants, achieved by doing nothing.
- **No `--deep`.** `tauri-macos-sign` builds `codesign --force -s <identity>` plus an optional
  `--options runtime` and `--entitlements` (`keychain.rs:194`). Nested signatures survive.
- **Notarization is free.** It runs on the whole `.app` after signing, so the appex rides along.

So the shape of the work is: build the `.appex` universal (`arm64` + `x86_64`), sign it with its
own entitlements and profile, and hand it to `bundle.macOS.files`. Since release builds split into
a compile phase with no secrets and a bundle phase beside the keys, that is two steps:
`clients/desktop/scripts/build-appex.mjs` compiles it unsigned from `beforeBuildCommand`, beside
`stage-proxy.mjs`, and `scripts/build-macos.ts` signs it in the bundle phase (profile from
`APPLE_AUTOFILL_PROVISIONING_PROFILE` in CI, or `clients/desktop/macos/profiles/`) and passes it
in the same `--config` that already carries the app's entitlements, its profile and the pre-signed
proxy. No Xcode project (see [What iteration 0 proved](#what-iteration-0-proved)). Every other
target is unaffected: build-appex skips any target that is not Apple.

The compile job hands the unsigned appex to the signing job with the app binary and the proxy
(`scripts/macos-handoff.ts`), and the signing job signs it with `APPLE_AUTOFILL_PROVISIONING_PROFILE`.
The core it links is built by `scripts/build-crypto-ffi.sh macos`, which build-appex runs every time.

**The bundler caveat is solved on main.** `sign()` applies one entitlements file to every sign
target, which killed the `bramble-proxy` sidecar once the app gained a restricted entitlement.
Touch ID unlock fixed it by pre-signing the proxy with no entitlements and shipping it as a plain
file in `Contents/Helpers` (`8b135a8f`, [release-signing.md](release-signing.md)). The appex
follows the same pattern.

Two follow-on questions, both since answered in
[What iteration 0 proved](#what-iteration-0-proved): the designation survives the app replacing its
own bundle, and registration works from `/Applications`, which both the `.dmg` drag and the
Homebrew cask satisfy.

### Handing a sandboxed extension the vault

**Answered, and it works the easy way.** App extensions are always sandboxed. The Tauri app is not,
and its vault lives in `~/Library/Application Support/app.bramble.desktop` via Tauri's
`app_data_dir()` (`src-tauri/src/storage.rs`), which the extension cannot read. This was the plan's
main design question and it is now observed rather than assumed:

- A **non-sandboxed writer** created `~/Library/Group Containers/BHGR3PP64J.group.app.bramble.desktop`
  with a plain `mkdir` and wrote a file into it. No `containermanagerd` metadata, no special API.
- The **sandboxed extension** resolved `containerURL(forSecurityApplicationGroupIdentifier:)` to
  exactly that path and read the file, confirmed both in the extension's log and by the value it
  filled into a Safari field.

So the app side can simply write to the group container path, and the iOS design ports unchanged.
The one thing not to guess is the identifier: macOS App Group identifiers for Developer ID apps
take a literal team-ID prefix (`BHGR3PP64J.group....`), unlike iOS's bare `group.app.bramble.mobile`
and unlike iOS's `$(AppIdentifierPrefix)` spelling for keychain groups. Read it back with
`codesign -d --entitlements`, which is the lesson the iOS keychain group already taught once.

Whatever the container turns out to be, the contents are the iOS design: the credential bundle
encrypted under the VEK, written by the app whenever the vault changes, plus `ASCredentialIdentityStore`
populated with metadata (service and username, never the password) so entries appear in QuickType.
Apple's model is explicit that the store holds metadata only and the OS calls back into the
extension for the secret when the user picks one.

### Unlocking inside the extension

The extension is a separate process, so it cannot borrow the app's in-memory VEK. iOS solves this
with its own unlock UI (biometric or master password) in the extension, and macOS should do the
same.

**The Touch ID half now exists in the app** (`743b71ce`, [desktop-biometric-unlock.md](desktop-biometric-unlock.md)).
`clients/desktop/src-tauri/src/biometric_macos.rs` keeps one item per vault in the data protection
keychain, access group `BHGR3PP64J.app.bramble.desktop`, gated by Touch ID (or Touch ID or the login
password, with passcode fallback), and authenticates an `LAContext` before reading it. The three
macOS differences this section used to list (no `SecAccessControl` in the `keyring` crate,
`kSecUseDataProtectionKeychain`, Touch ID being hardware-conditional) are all handled there.

What is left is letting the appex read the same item, so one Touch ID setup covers the app and
AutoFill. That is an entitlement question, not new crypto: add `BHGR3PP64J.app.bramble.desktop` to
the appex's `keychain-access-groups` (the profile grants `BHGR3PP64J.*`), or move the items to the
shared `BHGR3PP64J.app.bramble.desktop.shared` group with a one-time re-arm. Prefer the first; it
touches nothing that already works. The Secure Enclave upgrade (an enclave P-256 key and ECDH,
rather than a keychain blob) stays a separate decision for both.

## What iteration 0 proved

A stub extension was built, signed, notarized, bundled by Tauri, installed from a real `.dmg`,
designated in System Settings, and used to fill a field on a GitHub login page in Safari, on
2026-09-03. Everything below is observed on that machine, not reasoned.

### There is no Xcode project

An appex is a bundle with a Mach-O executable, an Info.plist and a signature, and `swiftc` produces
all three. `packages/platform-desktop/scripts/build-appex.mjs` builds it universal, signs it with
its own entitlements, and leaves it where `bundle.macOS.files` picks it up. A `.xcodeproj` would
add a large generated file to review and buy nothing.

### Three traps, in the order they bite

1. **The appex MUST carry `com.apple.security.app-sandbox`.** This is the one that costs days.
   Without it the extension builds, signs, notarizes, installs, and registers with Launch Services
   with a correct record (right `pluginIdentifier`, extension point, principal class and
   entitlements) and then simply never appears in AutoFill & Passwords. There is no error anywhere:
   not in `codesign`, not in notarization, not in the unified log. Xcode adds this automatically
   for an extension target, so hand-written entitlements are exactly where it goes missing.
   `pluginkit -m -i app.bramble.desktop.autofill` is the check that tells the truth; a `+` prefix
   means designated.
2. **The executable's entry point is `NSExtensionMain`, not `main`.** Link with
   `-Xlinker -e -Xlinker _NSExtensionMain` and compile `-parse-as-library`. Get this wrong and the
   binary loads fine and is never asked to do anything, which reads as a registration failure
   rather than a link one. Running the binary directly should say "An XPC Service cannot be run
   directly"; that is the quick confirmation.
3. **An unsized view controller hangs the host.** The credential provider is presented modally and
   Safari waits for `completeRequest` or `cancelRequest`. A view controller whose view has no
   workable layout presents as something unclickable, and the whole browser appears frozen: no
   field focus, no buttons, no reload. Set `preferredContentSize`, and prefer completing without UI
   where the flow allows it. `pkill -f BrambleAutoFill` releases the host.

### What was observed working

- **`bundle.macOS.files` puts the appex in the bundle.** Source paths resolve relative to
  `tauri.conf.json`, so `../macos/build/BrambleAutoFill.appex` is right, and it lands in
  `Contents/PlugIns/` with `embedded.provisionprofile` beside the app's in `Contents/`.
- **Tauri leaves the appex signature alone.** After a full build the appex still carries its own
  `app.bramble.desktop.autofill` entitlements, and `codesign -vvv --deep --strict` reports the
  nested bundle prepared and validated. Signing it in `build-appex.mjs` and letting Tauri sign the
  outer app last is the inside-out order, achieved by doing nothing special.
- **The bundler caveat is real.** `bramble-proxy` comes out signed with the *app's* entitlements,
  so the native-messaging helper now carries the autofill capability, the App Group and the
  keychain group. Harmless but wrong. Fixing it means taking signing over with `--no-sign`.
- **Notarization accepts the whole thing**, twice: the stub and the real bundle.
- **Registration does not require notarization.** The extension registered and was designated while
  the app was Gatekeeper-rejected as unnotarized, because re-signing had invalidated the staple.
  Notarization is still required for anyone else to run the app; it is just not the gate here.
- **Safari lists it and invokes it.** It appears in the AutoFill dropdown on a login form, and
  filling delivers the credential the extension returned.
- **The macOS 13 floor bites immediately**, which is decision 1 in
  [Sequencing decisions](#sequencing-decisions-that-keep-the-touch-id-future-open) validated on
  first contact: `ASCredentialRequest` is macOS 14, so `provideCredentialWithoutUserInteraction`
  needs both it and the older `ASPasswordCredentialIdentity` overload, `@available`-gated.

### The designation survives a bundle replacement

The worry was that the app self-updates by replacing its own bundle, and that the OS would drop the
user's AutoFill designation each time. A designation that disappeared on every release would be
worse than no feature.

It does not. Replacing `/Applications/Bramble.app` from the updater's own `Bramble.app.tar.gz`, the
way the updater does, changed the plugin UUID (`023349B2...` to `76D5BC8E...`, so the bundle really
was swapped) while the designation stayed enabled. Nothing to re-enable and nothing to prompt for.

`[partly verified]` This exercised the bundle replacement, not the Tauri updater plugin end to end:
the app validates the archive against the pubkey compiled in from `tauri.conf.json`, and the spike
built with a throwaway key, so `scripts/updater-smoke.ts` could not complete the download half. The
OS behaviour under test is the same either way, but if the plugin ever replaces bundles by some
route other than swapping the directory, this would need redoing.

## Iterations

Stated as user capabilities, because the OS floors and the framework phases do not line up with
what anyone can actually do.

### Iteration 0: prove the packaging (no user capability)

**Done, 2026-09-03.** The user gets nothing from it, and it must not ship: appearing in the list
and filling nothing is worse than being absent. Its only job was to retire the unknowns, and it is
the only part that could have failed in a way that killed the plan. It did not.
See [What iteration 0 proved](#what-iteration-0-proved).

**Rebased onto main 2026-11-15**, adapted to the two-phase release build, and turned into a passkey
probe: it now declares passkeys and logs every passkey request it receives, then declines. That
is how [the self-unlock blocker](#blocker-bramble-answering-its-own-unlock)'s routing question gets
answered by observation rather than by reading.

### Iteration 1: the shipping feature

Passwords, one-time codes and passkeys (with PRF) together. They are one controller, already
written and device-verified as a unit on iOS; splitting them means deleting working code and adding
it back. **Gated on [the self-unlock blocker](#blocker-bramble-answering-its-own-unlock)**: the
hidden unlock-key entry and its master-password guard ship in the same release, or not at all.

**In System Settings, the user can:**

- See Bramble under **AutoFill from** and enable it.
- Pick Bramble under **Verification Codes > Set Up Codes In**, so a 2FA setup link or QR code
  opens Bramble. This is the app registering the `otpauth` URL scheme, not the extension
  ([totp-uri-handler.md](totp-uri-handler.md), Phase 4). The extension's
  `ProvidesOneTimeCodes` only fills codes; on its own it does not put Bramble in that list (seen
  on the 2026-11-16 test build, and the stub's `Info.plist` comment claiming otherwise is wrong).
- Turn Apple Passwords off entirely and leave Bramble as the only provider, and still unlock the
  browser extension with Touch ID, through Bramble Desktop rather than Apple Passwords.

**In Safari, the user can:**

- Click a username field, see their Bramble logins inline in the QuickType bar, pick one, and have
  username and password both fill.
- Have a 2FA field offer the live code from Bramble and fill it in one click.
- Sign in to a site with a passkey stored in Bramble.
- Create a new passkey on a site and have it land in the vault and sync to their other devices,
  with no iCloud involved.
- Unlock Bramble when prompted, with the master password or Touch ID, without leaving the fill flow.

**In native Mac apps, the user can:**

- Fill logins and codes in any app whose developer adopted AutoFill.
- Sign in with a Bramble passkey in any app at all, since passkeys need no per-field adoption.

**The user still cannot:**

- Save a newly typed password from Safari. They add it by hand. Passkeys are captured; passwords
  are not, permanently.
- Get password or code fill in Chrome, Firefox or Electron apps from this (the extension covers
  the browsers).
- Store the extension's own unlock key in Bramble. Refused on purpose.

**Per-version degradation:** macOS 13 gives passwords, 14 adds passkeys, 15 adds one-time codes.
All `@available`-gated inside the extension, so the app's own minimum does not move.

The `ASCredentialIdentityStore` belongs in this iteration, not a later one. Without it credentials
appear only behind a manual picker rather than inline in QuickType, which is the difference users
actually judge the feature on.

### Iteration 2: Touch ID as the unlock (folded in)

Both halves are spoken for. The desktop app unlocks with Touch ID since `743b71ce`. The extension
unlocking through the desktop over the native-messaging link moved into iteration 1 as the desktop
key in [Decision](#decision), because iteration 1 is what lets a user turn Apple Passwords off.

### Iteration 3: Bramble as a PRF provider (folded in)

Done on every other surface ([passkey-prf.md](passkey-prf.md)) and part of the iOS controller this
ports, so it arrives with iteration 1, behind the `bramble.sh` guard.

### Iteration 4: decide the leftovers with real data

- **Auto-type** for Electron apps. Only worth building if the gap actually bites, and this is the
  iteration where that is known rather than guessed.
- **Insert any vault field into any text field** (`prepareInterfaceForUserChoosingTextToInsert()`,
  macOS 14).
- **Site-driven password updates**: a site reports a change and Bramble updates the entry without
  the user retyping it (`ASCredentialUpdater`, macOS 15).

## Sequencing decisions that keep the Touch ID future open

None of these add work. They are the same build, ordered so the Touch ID and PRF paths stay
reachable.

1. **Do not raise `LSMinimumSystemVersion`.** Keep the app's floor where it is and `@available`-gate
   inside the extension, exactly the pattern iOS settled on (15.0 deployment target,
   `@available(iOS 17, *)` on the passkey code, `@available(iOS 18, *)` on the one-time-code code).
   The macOS 15 PRF API is gated the same way, so PRF arrives without excluding anyone.
2. **Build the appex's unlock on the desktop's Touch ID item from the start**, not
   master-password-only with biometrics bolted on afterwards. The primitive exists
   (`biometric_macos.rs`).
3. **Reuse the iOS bundle shape for the shared container**, which already carries passkeys, rather
   than inventing a password-only format and migrating it later.
4. **Nail the App Group and keychain-access-group identifiers once**, team-prefixed, and verify with
   `codesign -d --entitlements` rather than by reasoning. That specific guess cost a long debugging
   loop on iOS.

## Blocker: Bramble answering its own unlock

**Status (2026-11-16): revised decision built, not device-checked.** The first answer (refuse
`bramble.sh` everywhere, and give the extension Touch ID through the desktop link) was built and
then removed. Device testing showed macOS preselects Bramble for every new passkey, so that refusal
met every Mac user setting up Touch ID, and the circularity it guarded against turned out to be an
inconvenience rather than a lockout (see [Decision](#decision)). The spike passed, and the revised
decision below is what the branch now does.

### The scenario

1. A user sets up Touch ID in the browser extension. That is a platform passkey: rpID
   `bramble.sh`, user `vault@local`, rp name "Vault", PRF on create and get
   (`packages/core/src/vault/webauthn-ceremony.ts`, `createPrfCredential`). On a Mac it lands in
   Apple Passwords, which is what makes it unlock the extension in both Chrome and Firefox.
2. They install Bramble Desktop, enable it under **AutoFill & Passwords**, and maybe switch Apple
   Passwords off, which is exactly what iteration 1 below promises they can do.
3. From then on, the extension's own unlock is a WebAuthn ceremony with Bramble Desktop on the list
   of things that may answer it.

The extension already learned this lesson once in-browser: its own Chrome passkey provider
(`chrome.webAuthenticationProxy`) would hijack the unlock ceremony, so the ceremony detaches it for
the duration (`setWebauthnInterceptionPauser`). A macOS provider sits below the browser, where the
extension has no such switch.

### What the old analysis got wrong

The previous version of this section listed three things that kept the unlock passkey out of the
vault. As of today none of them holds on its own:

1. "Chrome on macOS does not route to system providers." Wrong for passkeys. Chrome and Firefox
   both reach Apple Passwords through Apple's API, which is why the unlock passkey roams between
   them, and on macOS 14+ that same call reaches enabled third-party providers
   ([below](#how-a-request-reaches-a-provider)). It is right for passwords only.
2. "`allowCredentials` pins the unlock to credential IDs Apple minted." True for a credential only
   Apple holds. **Credential exchange breaks it**: an Apple Passwords export on macOS or iOS 26.4+
   carries the passkey's `hmacCredentials`, and Bramble imports them
   ([credential-exchange.md](credential-exchange.md), [passkey-prf.md](passkey-prf.md)). A user
   moving from Apple Passwords to Bramble, which is precisely the user enabling this provider, brings
   the `bramble.sh` passkey along with a working PRF. Bramble then holds the same credential ID and
   answers with the same PRF output, so the unlock succeeds through Bramble.
3. "Enrollment refuses a provider with no PRF." Every Bramble provider answers PRF now: the
   extension, Android, and iOS (`500c03c2`), which is the controller this extension is ported from.

So the circular case is reachable two ways: **create** (setup picks Bramble) and **import** (the
migration carries the existing one in). The import path does not even need this extension: an
iPhone with Bramble as its provider, holding an imported `bramble.sh` passkey, can answer a Mac
extension's unlock over the "use a phone" QR flow today. That last path is reasoned from how
hybrid works, not observed.

### Why it matters

- **It is a lockout path.** The key that unlocks the vault lives inside a vault. If that is the same
  vault and it has no other primary method (a password-less vault, see
  [auth-and-unlock.md](auth-and-unlock.md)), unlocking needs a desktop that is itself unlocked. Same
  family as #27, and it fails only on the day the user is already locked out.
- **It breaks silently on migration.** A user who turns Apple Passwords off may lose the Touch ID
  unlock they had, with an error that blames the prompt (`UNLOCK_FAILED`), not the setting.
- **It is confusing even when it works.** A Bramble sheet asking to unlock Bramble, to unlock
  Bramble.

### How a request reaches a provider

Researched 2026-11-15 from Chromium and Firefox source, Apple's docs and Apple engineers' forum
answers. **Confirmed** means one of those; **reported** means users or vendors. The stub probe
turns the reported and unknown rows into observations.

| Question | Answer | Status |
|---|---|---|
| Does Chrome's platform create/get reach a third-party provider? | Yes on macOS 14+. Chrome drives `ASAuthorizationController` with `ASAuthorizationPlatformPublicKeyCredentialProvider` and lists with `ASAuthorizationWebBrowserPublicKeyCredentialManager`, which Apple documents as including credentials "managed by third-party credential managers". Chrome calls the whole path "Apple Passwords" and shows each passkey's provider name since 135 ([source](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/device/fido/mac/icloud_keychain_sys.mm)) | Confirmed |
| Firefox? | Same Apple API, on by default since macOS 13.3 ([source](https://github.com/mozilla-firefox/firefox/blob/main/dom/webauthn/MacOSWebAuthnService.mm)) | Confirmed |
| Safari? | Yes, macOS 14+ | Confirmed |
| Who picks where a new passkey goes? | The user, in the system sheet: Apple calls the registration method "when the user selects your extension". **Observed 2026-11-16 (macOS 26.6, extension Touch ID setup): with Bramble enabled, the sheet preselects Bramble** ("A passkey for vault@local will be saved in Bramble"), so the refusal is hit on every setup unless the user switches destination | Confirmed / observed |
| Can get() reach a provider that lacks the credential? | No. With `allowCredentials`, a provider is offered only if it registered a matching `ASPasskeyCredentialIdentity` (Apple engineers, [745605](https://developer.apple.com/forums/thread/745605), [736486](https://developer.apple.com/forums/thread/736486)); Chrome also filters the list against `allowCredentials` itself | Confirmed |
| Does PRF pass through? | Browsers hand PRF to the system request on macOS 15+ (Chrome 132, Firefox 139), and the provider-side PRF types are macOS 15 | Confirmed. **Observed 2026-11-16 (spike, macOS 26.6): Firefox and Vivaldi create the extension's `bramble.sh` key in Bramble with PRF and unlock with it.** Chrome for Testing cannot reach the sheet at all (no `web-browser.public-key-credential` entitlement) |
| With Apple Passwords switched off, do existing iCloud passkeys still answer get()? | Not documented | Unknown |
| Can the relying party tell which provider made a credential? | No. Chrome keeps the AAGUID under `attestation: "none"`, but iCloud Keychain reports all zeros, and macOS 26.2 is reported to zero third-party AAGUIDs too ([814547](https://developer.apple.com/forums/thread/814547)) | Confirmed / reported |
| Can the relying party steer away from a provider? | No. `hints` (`client-device`) and `authenticatorAttachment` pick a class, not a vendor | Confirmed |

Read against the scenario: **the create path is open** in every browser the extension runs in, so
a user can save the unlock key to Bramble with one click in the system sheet. **The get path is
closed unless Bramble holds the credential**, which the import path supplies. Both are closed by
the same rule: Bramble never registers, mints or signs for `bramble.sh`.

**Side finding, not this project's:** Firefox's source sends a PRF get() to its own security-key
code, bypassing macOS, when no `allowCredentials` entry lists the `internal` or `hybrid`
transport, on macOS before 26.4. The extension's `getPrfSecret` lists none, so Touch ID unlock in
Firefox on macOS 15 to 26.3 may not reach Apple Passwords at all. Recent and unverified (the
Bugzilla entry was reopened); worth a check on such a Mac, and the likely fix is listing
transports on platform slots.

### Decision

Revised 2026-11-16. **Bramble keeps the extension's Touch ID passkey, in the vault, as a hidden
entry that no client shows.** The extension's "This device" setup goes through the macOS sheet as
today; with Bramble enabled the sheet already defaults to Bramble, and Bramble now says yes.

**Why the circularity is acceptable.** The passkey only unlocks the vault it sits in when the
browser and the desktop share that vault, and sharing a vault means linking, which requires a
master password. So the worst case is typing the master password, not a lockout. The one way to
turn that into a lockout is guarded (below). Everything else is a trade-off, and "native" (the key
is vault data, managed like every other passkey) won over keeping it outside the vault.

**What changes:**

1. **A hidden entry type**, `unlock-key`: the `bramble.sh` passkey and nothing else, created by the
   macOS AutoFill extension through the same pending-passkey handoff and core create function as
   every other passkey. Placement routes a `bramble.sh` passkey to this type instead of a login.
2. **It never leaves this Mac.** The entry's envelope carries a plaintext `localOnly: true` (the
   type itself is inside the ciphertext), and everything that sends entries off the device drops
   such entries: sync's local payload, the desktop link's vault copy, the mailbox, combining
   vaults. Incoming syncs cannot remove it, because merging is a union and only a tombstone
   deletes. So only the Mac that made it ever holds it, and that Mac's desktop app is new enough
   to hide it by definition.
3. **No client shows it.** Vault lists, search, counts, item views, tags and the login index all
   skip `unlock-key`. Since it never syncs, clients released before this never receive it; only
   downgrading Bramble Desktop on that Mac would show it, as a login row.
4. **Only the macOS AutoFill extension serves it.** The desktop's provider mirror and identity list
   include `unlock-key` passkeys, so macOS offers Bramble for the extension's unlock like any other
   passkey. iOS and Android keep refusing `bramble.sh` at create and never serve it, and the
   extension's own Chrome passkey provider never answers it (it is paused during unlock anyway).
5. **The rule moves out of the crypto core.** `passkey_make_credential_core` and
   `passkey_get_assertion_core` stop refusing `bramble.sh`; the rule becomes "a `bramble.sh`
   passkey is only ever an `unlock-key` entry, and only the macOS provider serves it". The checks
   in `findPasskeys`, the index builders, Android and iOS stay.
6. **The lockout guard.** The master password cannot be turned off while every remaining primary
   unlock key is one Bramble holds. The extension never sees the entry, and the AAGUID does not
   survive, so the AutoFill extension marks what it mints for `bramble.sh`: a fixed prefix
   (`BRMU`) on the credential ID, which the browser hands back as the new key's `rawId` and the
   vault keeps in that key's slot. Turning the password off, or removing the last other key from
   a vault without one, is refused while only such keys remain; Settings says why.
7. **Unlock needs Bramble Desktop's Touch ID on**, because the AutoFill extension must decrypt the
   vault before it can answer; without it, every browser unlock asks for the master password. The
   extension's Touch ID setup says so on a Mac when Bramble answered.
8. **Exports.** Bramble's own backups and encrypted exports keep `unlock-key` entries, since both
   are this device's vault file. KeePass and credential-exchange exports leave them out: the key
   only works on this Mac, with this Mac's Bramble.
9. **Managing it.** Bramble Desktop's Settings lists these keys and can remove them. Removing the
   Touch ID key in the extension only removes its slot; the entry stays on the Mac, unused, until
   removed in Bramble Desktop. Harmless, since nothing else can ask for it.
10. **Retired:** the "Can't save here" refusal in the macOS AutoFill extension, and the desktop key
   over the link (unlock linking and full linking for Touch ID, Phase B of the plan). One mechanism
   is enough; both are removed.

A passkey the AutoFill extension creates, this one included, works straight away: the extension
reads its own pending handoff alongside the mirror and lists the new identity with macOS, so the
next sign-in does not wait for Bramble Desktop to take it in.

**Spike passed 2026-11-16** (Firefox and Vivaldi; commit `34ad2d94`). The decision stands.

**The spike, as run.** One unknown decided all of this: a PRF round trip from Brave and from Firefox
through a third-party provider has never been observed. The spike is a test build whose AutoFill
extension creates and answers the `bramble.sh` passkey with PRF, tried in both browsers on macOS
15+. If PRF does not come back, the revision fails and the built answer stands.

### The desktop app's own Touch ID is outside this

Checked 2026-11-15 against `clients/desktop/src-tauri/src/biometric_macos.rs`. Setting up Touch
ID in Bramble Desktop involves no passkey at all, so nothing above can capture it:

- It is a generic password item holding the vault's VEK (service `app.bramble.desktop.biometric`,
  account `vek:<vault id>`) in the data protection keychain, app group
  `BHGR3PP64J.app.bramble.desktop`, gated by an `LAContext` and `.biometryCurrentSet` (or
  `.userPresence` with the login-password fallback). No `ASAuthorization` call, so no system sheet
  and no provider list.
- `AccessibleWhenUnlockedThisDeviceOnly`: never synced, never in iCloud Keychain, never visible in
  Apple Passwords. Turning Apple Passwords off, or enabling Bramble as a provider, does not touch
  it.
- The desktop has no WebAuthn unlock at all (`webauthnUnlock` and `securityKeys` are off for
  `desktop` in `packages/core/src/flags.ts`), so there is no desktop ceremony for the appex to
  answer.
- It is a cache of the VEK, not a slot in the vault file, so it never travels with the vault and
  never counts as a primary unlock method.

So it is the anchor the rest leans on, not a risk. Three things to get right when the appex reads
it:

- **Entitlement.** The appex's `keychain-access-groups` lists only
  `BHGR3PP64J.app.bramble.desktop.shared` today. It needs `BHGR3PP64J.app.bramble.desktop` as
  well, or it can never see the item. Verify with `codesign -d --entitlements`, not by reasoning.
- **Read, never write.** Only the app arms or disarms Touch ID (`58f28819`, "don't re-arm behind
  the user's back"). The appex authenticates first and reads, as `load()` does, and may delete an
  item a fingerprint change killed, which is what `load()` does too, so the app's toggle and the
  appex agree.
- **One enrollment, three users.** The app, the appex and, through the appex, the browser
  extension's unlock key all sit behind the same fingers. A change to them drops all three back to
  the master password at once, which is the intended `.biometryCurrentSet` behaviour.

### Rejected

- **Keep the unlock passkey in the Mac keychain instead of the vault** (2026-11-16). It never
  syncs and no client could show it, but it sits outside everything Bramble already manages: its
  own storage in the AutoFill extension, its own list for macOS, its own create path. Chosen
  against for "native". With the entry local-only, the vault keeps the keychain's two advantages
  (no sync, no old client ever sees it).
- **Unlock linking and full linking for Touch ID** (the built desktop key). It works, but needs
  pairing for something macOS already brokers, and two mechanisms for one job.
- **Steer the ceremony away from third-party providers** from the extension. WebAuthn gives the
  relying party no say in which provider answers; `authenticatorAttachment` and `hints` choose a
  class of authenticator, not a vendor.
- **Drop `bramble.sh` passkeys on import.** Data loss; the guard makes them harmless instead.
- **Have the extension refuse an unlock key minted by Bramble**, by its AAGUID
  (`4249c72f-...`). The AAGUID does not survive: iCloud Keychain reports zeros, and macOS 26.2 is
  reported to zero third-party ones, so the extension cannot tell who made the key.

### Confirming it on a device

One signed build checks what is built:

1. Build signed (`BRAMBLE_SKIP_NOTARIZE=1 pnpm build:macos --aarch64`; registration does not need
   notarization) and install it over `/Applications/Bramble.app`, after keeping a copy of the real
   one. Enable Bramble under **AutoFill & Passwords**, and turn on Touch ID in Bramble Desktop.
2. `log stream --predicate 'subsystem == "app.bramble.desktop.autofill"' --level info`
3. In Firefox and in Vivaldi (Chrome needs the browser entitlement, which Chrome for Testing lacks),
   add a Touch ID key in the extension and pick Bramble in the sheet. Expect Touch ID, then the
   key in the extension's list as "in Bramble Desktop".
4. Lock the extension and unlock with that key, before and after Bramble Desktop has been opened.
   Then turn Touch ID off in Bramble Desktop and unlock again: the AutoFill sheet asks for the
   master password.
5. In the extension's Settings, try to turn the master password off with only that key: refused,
   with the reason shown.
6. On another device in the same sync group, sync: no new entry appears.
7. In Bramble Desktop, Settings > Security lists the key by date; remove it, then unlock the
   extension: it falls back to the master password or its other keys.
8. In Safari: fill a login, a one-time code (macOS 15), sign in and register on webauthn.io, and a
   PRF site; then open Bramble Desktop and confirm the new passkey is in the vault.
9. On an iPhone, since the iOS extension's pure code moved into `AutofillCore.swift`: a password
   fill, a passkey create and sign-in on webauthn.io, and a one-time code.
10. Bramble listed under Set Up Codes In, and the device checklist in
    [totp-uri-handler.md](totp-uri-handler.md), Phase 4.
11. Restore the real app.

### What the PRF work changed

Answering PRF as a provider is no longer future work: Bramble computes it from per-credential
secrets on every surface ([passkey-prf.md](passkey-prf.md)), and the iOS controller this appex is
ported from already does. So the old iteration 3 is part of the port, and the guard above is what
keeps it pointed at other sites only.

## Open questions

- ~~Deployment floor.~~ Resolved by decision 2 above: floor stays put, capabilities are
  `@available`-gated per method, users degrade by OS version. Note that raising
  `LSMinimumSystemVersion` would also disturb the Homebrew cask's bare `depends_on :macos`
  (`desktop-port.md:935`), which is another reason not to.
- Whether the extension should reuse the desktop app's existing OS-credential-store usage (backup
  credentials, the browser-link pairing key) or stay strictly App Group plus its own keychain group.
- Whether a "keep unlocked" session shared between app and extension is wanted, as on Android, or
  whether each unlock stands alone.
- Whether the biometric-gated key should be a Keychain blob (iOS parity, less code) or a Secure
  Enclave key (better on a shared-disk platform).
- From the blocker: whether existing Apple Passwords passkeys still answer with Passwords switched
  off. (The sheet defaults to Bramble, and PRF completes through it in Firefox and Vivaldi.)
- Whether the browser extension should say, after a Touch ID enrollment change, that its key now
  needs the master password, rather than leaving the AutoFill sheet to ask.
