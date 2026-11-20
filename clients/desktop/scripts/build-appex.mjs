/*
 * Compile the macOS AutoFill credential provider extension, unsigned, for build-macos.ts to sign
 * with its own entitlements and profile and drop into Contents/PlugIns. No Xcode project: swiftc
 * makes the executable and the Info.plist is copied. See docs/macos-credential-provider.md.
 *
 * Runs as beforeBuildCommand, so in the compile phase that holds no signing material.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const macos = join(here, "..", "macos");
const src = join(macos, "BrambleAutoFill");
const out = join(macos, "build");
const appex = join(out, "BrambleAutoFill.appex");
const NAME = "BrambleAutoFill";
const repo = join(here, "..", "..", "..");
// The shared Rust core as a universal staticlib plus its Swift glue (build-crypto-ffi.sh macos).
const ffi = join(macos, "ffi");
const headers = join(ffi, "headers");
// The UI-free provider code iOS's extension already runs, shared rather than copied.
const shared = join(repo, "clients", "mobile", "ios", "App", "AutoFillProbe");
// The floor at which a user can designate a provider; newer APIs are @available-gated in Swift.
const DEPLOYMENT = "13.0";

// Same target source as stage-proxy.mjs: a Windows build cut on a Mac must not build this.
const target = process.env.BRAMBLE_TARGET ?? "";
if (process.platform !== "darwin" || (target && !target.includes("apple-darwin"))) process.exit(0);

// Every time, so the appex never links a stale core; cargo makes an unchanged rerun take seconds.
execFileSync("bash", [join(repo, "scripts", "build-crypto-ffi.sh"), "macos"], { stdio: "inherit" });

const sdk = execFileSync("xcrun", ["--sdk", "macosx", "--show-sdk-path"], {
	encoding: "utf8",
}).trim();

function compile(arch) {
	const bin = join(out, `${NAME}-${arch}`);
	execFileSync(
		"swiftc",
		[
			"-target",
			`${arch}-apple-macos${DEPLOYMENT}`,
			"-sdk",
			sdk,
			"-O",
			"-parse-as-library",
			// An appex starts at NSExtensionMain; without this it loads and is never called.
			"-Xlinker",
			"-e",
			"-Xlinker",
			"_NSExtensionMain",
			// No debug map. It names the Rust staticlib by its absolute path, so the binary would
			// depend on where the checkout is (docs/reproducible-builds.md); no dSYM ships to use it.
			"-Xlinker",
			"-S",
			"-I",
			headers,
			"-Xcc",
			`-fmodule-map-file=${join(headers, "module.modulemap")}`,
			"-L",
			ffi,
			"-lvault_crypto",
			"-emit-executable",
			"-o",
			bin,
			join(src, "CredentialProviderViewController.swift"),
			join(src, "Views.swift"),
			join(shared, "AutofillCore.swift"),
			join(shared, "AutofillStyle.swift"),
			join(shared, "Totp.swift"),
			join(ffi, "vault_crypto.swift"),
		],
		{ stdio: "inherit" },
	);
	return bin;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(appex, "Contents", "MacOS"), { recursive: true });

const universal = process.env.BRAMBLE_UNIVERSAL || target.includes("universal");
const arches = universal ? ["arm64", "x86_64"] : [process.arch === "x64" ? "x86_64" : "arm64"];
const slices = arches.map(compile);
const binary = join(appex, "Contents", "MacOS", NAME);
if (slices.length > 1) execFileSync("lipo", ["-create", ...slices, "-output", binary]);
else copyFileSync(slices[0], binary);
for (const s of slices) rmSync(s, { force: true });

const plist = join(appex, "Contents", "Info.plist");
copyFileSync(join(src, "Info.plist"), plist);
const { version } = JSON.parse(readFileSync(join(here, "..", "src-tauri", "tauri.conf.json"), "utf8"));
execFileSync("plutil", ["-replace", "CFBundleShortVersionString", "-string", version, plist]);

// The String Catalog, compiled to one .lproj per language; Xcode would do this, swiftc doesn't.
const resources = join(appex, "Contents", "Resources");
mkdirSync(resources, { recursive: true });
execFileSync("xcrun", [
	"xcstringstool",
	"compile",
	join(src, "Localizable.xcstrings"),
	"--output-directory",
	resources,
]);

console.error(`build-appex: ${appex} (${arches.join(", ")}, unsigned)`);
