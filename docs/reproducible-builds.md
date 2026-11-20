# Reproducible builds

Anyone can rebuild a Bramble release from its tag and get the same bytes we published. That is
what makes the source the thing to audit: a build that matches it cannot hide anything the source
does not show, and a build that does not match is evidence that something was added.

| Target | Reproducible | Checked |
|--------|--------------|---------|
| Firefox extension | Yes, every file | Daily in CI: what addons.mozilla.org serves, and the GitHub zip |
| Chrome extension | Yes, every file | Daily in CI: what the Chrome Web Store serves, and the GitHub zip |
| Android APK | Yes, every file but the signature | Daily in CI: the newest GitHub release |
| Desktop, Linux | `.deb` and AppImage byte for byte from the release after 0.19.0, every installed file before it; RPM contents only | Daily in CI, amd64 and arm64: the newest GitHub release |
| Desktop, macOS | The app, proxy and AutoFill extension binaries, signatures aside, from the release after 0.19.0 | By hand on a Mac (`--macos`); updates are transparency-logged |
| Desktop, Windows | The installer, signature aside, from its first release | By hand (`--windows`); updates are transparency-logged |
| iOS app | Cannot be checked: the App Store re-encrypts every binary | No |

## Checking a release yourself

You need git, Node 24 and Docker. From a clone with its tags:

```sh
node scripts/verify-release.ts 1.37.0-firefox      # one release, by its tag
node scripts/verify-release.ts --live chromium     # whatever the store is serving right now
node scripts/verify-release.ts 1.40.0-chromium --no-store
node scripts/verify-release.ts --live android      # the newest Android release
node scripts/verify-release.ts 0.19.0-desktop --arch arm64   # desktop Linux packages
node scripts/verify-release.ts 0.20.0-desktop --macos        # desktop macOS binaries, on a Mac
node scripts/verify-release.ts 0.20.0-desktop --windows      # desktop Windows installer
```

It builds the tag in `docker/reproducible-build.Dockerfile` and compares every file with:

- **the GitHub release's zip**, after checking the zip against the release's `SHA256SUMS`;
- **the store's package**: the `.xpi` addons.mozilla.org hands to Firefox, checked against AMO's own
  hash, or the `.crx` the Chrome Web Store hands to Chrome. The Chrome Web Store only serves its
  current version, so an older Chrome release is compared with GitHub alone.

`.github/workflows/verify-releases.yml` runs `--live` for both stores and Android every day, so a
store serving something other than what the source builds would turn up within a day.

**Android** builds in the same base image with `docker/reproducible-android.sh`, which installs what
the release runner has: Temurin 21, the Android SDK platform 36 and NDK 27.3.13750724, cargo-ndk
4.1.2, Node and wasm-pack, each pinned. The SDK is large, so it and the package caches live in
`BRAMBLE_VERIFY_CACHE` (default `~/.cache/bramble-verify`, about 6 GB) rather than in an image. The
APK is compared entry by entry with the one on the GitHub release, after checking that against
`SHA256SUMS`. Releases are signed v2 and v3 only, and those signatures live in a block outside the
zip entries, so nothing is set aside: every entry must match, the four Rust libraries and the WASM
included. 0.31.0 did, all 542 entries (2026-11-17). Every package is read from the archive itself
rather than unpacked to disk: an APK's shrunk resource names differ only by case (`res/9n.9.png`
and `res/9N.9.png`), and a case-insensitive file system would merge them and compare fewer files
than there are. `--apk <file>` compares an APK you built some other way, natively on x86_64 Linux
for instance, without Docker.

Under emulation on Apple silicon, Gradle's aapt2 daemons sometimes hung at startup when many ran at
once, so the script runs Gradle with two workers and the Kotlin compiler in-process. Neither changes
the output; on an x86_64 machine it only makes the build slower.

## What the stores change

Each store adds its own signature, and that is all a package may differ by:

- **addons.mozilla.org** adds `META-INF/` (Mozilla's signature) and reformats `manifest.json`
  without changing what it says.
- **The Chrome Web Store** adds `_metadata/` (its hashes of every file, which Chrome checks) and an
  `update_url` key to `manifest.json`.

So `manifest.json` is compared as data with only `update_url` allowed to differ, those two folders
are ignored, and every other file must match byte for byte. The GitHub zip leaves out the
TypeScript declarations and `wasm/package.json` (the `zip -x` list in
`clients/extension/package.json`), which the store packages carry; those are compared too.

## Why the build runs as x86_64 Linux

The JavaScript, HTML and CSS come out identical on any machine. The WASM crypto core does not. Its
contents depend on the platform the build runs on, through two things found by rebuilding
1.37.0 on a Mac and on Linux (2026-11-17):

1. **The host platform.** Built on an Apple silicon Mac, on arm64 Linux and on x86_64 Linux, the
   same commit gives three different WASM files, each the same every time, and only x86_64 Linux,
   the release runner's platform, matches what shipped. The files hold the same strings in a
   different order, which points at symbol hashes: Cargo hashes the host into proc-macro and build
   script units, and those feed the hashes of the crates that use them. That cause is inferred, not
   traced; the platform dependence is measured.
2. **wasm-bindgen must be the prebuilt binary.** wasm-pack 0.13.1 (what CI pins) downloads the
   wasm-bindgen release binary for the version in `Cargo.lock`. Newer wasm-pack builds it from
   source without a lockfile, which picks up newer dependencies (walrus 0.26.2 against 0.26.1) and
   produces different bytes.

The paths rustc would otherwise embed are already normalised by `scripts/rustflags-reproducible.sh`
(which `wasm:build` uses), so where the repository is checked out does not matter.

So the image is pinned to the release runner's platform: `--platform linux/amd64`, the Rust 1.95.0
image by digest, wasm-pack 0.13.1 and Node by checksum, and pnpm by `packageManager`. On Apple
silicon Docker emulates it, which costs a few minutes.

## What could break it

- **A floating tool in the release workflow.** `firefox-release.yml` and `chrome-release.yml` take
  `node-version: 24`, not an exact version. The bundler's output has not depended on Node's minor
  version so far; if it ever does, the daily check fails and the two must be pinned together.
- **Bumping wasm-pack or the Rust toolchain** in CI without the same change to the Dockerfile.
  Change both in one commit; the next day's check proves the pair.
- **A build step that reads the clock or the machine.** None does today. The zip archives
  themselves are not byte-identical (zip stores file times), which is why the check compares their
  contents rather than the archive's hash.

## Desktop

**Linux.** Rebuilding 0.19.0 for arm64 in the release's own container (2026-11-17) gave the same
files as the published packages: both binaries and everything else in the `.deb`, and all 455
files in the AppImage, the bundled WebKit included. The Rust output needed none of the remapping
the WASM and Android builds use, because the container always builds at the same paths
(`/work/repo`, `/opt/cargo`, `/opt/rustup`). What differed was the packaging around the files, and
that is now pinned:

- **The `.deb`** stored the build time and the builder's uid in its archive headers, listed its
  checksums in the file system's directory order, and counted directory sizes into
  `Installed-Size`, which differ between file systems. `scripts/deb-reproducible.ts` rebuilds it
  with `dpkg-deb` under `SOURCE_DATE_EPOCH`, root ownership, sorted `md5sums`, and
  `Installed-Size` from file sizes alone.
- **The AppImage** carried each file's build-time mtime, and the image's creation time; the 16
  bytes of MD5 the runtime header holds over the image followed from those. The repack in
  `appimage-portability.ts` now sets every time in the AppDir to `SOURCE_DATE_EPOCH` first and
  hands the packer the same.
- **`SOURCE_DATE_EPOCH`** is the commit's time, which `build-linux.ts` passes into the container.

Two builds of 0.19.0 with these changes, one on APFS as uid 501 and one in a Docker volume as uid
1001, gave the same `.deb` and AppImage to the byte.

`verify-release.ts <version>-desktop --arch amd64|arm64` builds the tag in the tag's own image with
`docker/reproducible-desktop.sh` and compares the `.deb`, AppImage and RPM with the release's. It
lists the files inside each package on both sides too, so a mismatch names the files that differ
and a release from before `deb-reproducible.ts` is held to what it installs. The default
architecture is the host's: the other one runs under emulation, which is slow.

**The RPM** still records its build time and the files' mtimes, because Tauri's bundler takes
neither from `SOURCE_DATE_EPOCH`; its files match, and CI adds a GPG signature to its header
anyway. So an RPM is checked by contents, not bytes, until the bundler can pin those times.

**The libraries the AppImage bundles** come from Debian, so the build image installs from a dated
`snapshot.debian.org` archive (`DEBIAN_SNAPSHOT` in `clients/desktop/docker/linux-build.Dockerfile`)
on a base pinned by digest, rather than from the live mirrors, whose packages change under an old
tag. Bumping the date is how a release takes Debian's updates, WebKit's security fixes in
particular, so bump it before a desktop release and commit the bump on its own.

**macOS.** Rebuilt twice from scratch at one path, the universal binaries come out the same to
the byte; from two paths they did not, even with every path remapped. The desktop crate reaches
`packages/core-rust` by a path outside its own workspace, and Cargo hashes such a dependency by its
absolute path, which reaches symbol names and code layout. So a release compiles at one fixed path,
`/private/tmp/bramble` (`scripts/canonical-path.ts`): `build-macos.ts --compile-only --canonical`
mirrors the tree there (sources and `node_modules`, no secrets), compiles, and copies the binaries
back for bundling and signing. Both release routes do that, and the desktop build now remaps the
compiler's paths (`rustflags-reproducible.sh`, `-ffile-prefix-map`) on every platform, so the
registry's location does not show either. 0.19.0 and earlier carry the CI runner's own paths, 1,761
of them, and cannot be rebuilt anywhere else.

The released app is signed with Developer ID and notarized; a rebuild carries only the linker's ad
hoc signature. `verify-release.ts <version>-desktop --macos` removes the signature from both and
compares what is left, with one field set aside: `codesign` grows `__LINKEDIT`'s `vmsize` to fit a
signature and leaves it grown when the signature is removed, so `scripts/macho-normalize.ts` zeroes
it on both sides. It needs the Xcode the release used (`xcode` in `desktop-release.yml`, 26.4 at
the time of writing), since the linker is part of the output. It compares the app and proxy
binaries, which hold the code and the web assets, and the AutoFill extension's from the release
that first ships it; the rest of the bundle (`Info.plist`, icons, the provisioning profiles) is not
yet compared.

The AutoFill extension is the one part that does not need the fixed path. `build-appex.mjs` links
it without a debug map (`-Xlinker -S`): the map named the Rust staticlib by absolute path, and with
it gone, two builds from different checkouts came out identical, `Info.plist` and compiled strings
included.

**Windows.** The installer used to be built natively on a Windows runner, which nobody without
Windows and MSVC could repeat. It is now cross-compiled with `cargo-xwin` in
`clients/desktop/docker/windows-build.Dockerfile` (`build-windows.ts --container`), on a Linux arm64
runner, and only the Authenticode signing still runs on Windows, over that installer as an
artifact. The image pins Debian 13 by digest and snapshot (for NSIS 3.11, which Tauri's installer
script needs), clang and lld from it, Node, `cargo-xwin`, and the Microsoft CRT and Windows SDK
versions it downloads. Three things had to change for two builds to agree:

- **The PE timestamp and the debug directory**, which `lld-link` fills from the clock and a fresh
  PDB: linked with `/Brepro` and `/DEBUG:NONE` (no PDB ships).
- **File times in the installer**: NSIS stores each packed file's mtime in its solid stream, so one
  differing time changes nearly every byte after it, and Tauri rewrites the binary just before
  packing. The image puts a `makensis` wrapper first on the path that adds `SetDateSave off`, and
  makensis takes the installer's own time from `SOURCE_DATE_EPOCH`.
- **`SOURCE_DATE_EPOCH`**, the commit's time, as for Linux.

Two builds, as root and as another user, gave the same installer and the same app and proxy
binaries. `verify-release.ts <version>-desktop --windows` builds a tag the same way and compares
with the published installer once `scripts/pe-normalize.ts` has taken the Authenticode signature
off: the certificate table, the padding before it, the checksum and the security directory entry.
The installer is the only file signed; the binaries inside it are not, so they are compared as
part of its bytes. Windows has not shipped yet, so its first release is the first one to check.
