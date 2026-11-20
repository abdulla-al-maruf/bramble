// Rebuild a release from its tag and check it byte for byte against what was published: the zip
// or APK on the GitHub release, and for the extensions the package the store hands to users.
//
//   node scripts/verify-release.ts 1.37.0-firefox       # a release by its tag
//   node scripts/verify-release.ts --live chromium      # whatever the store is serving right now
//   node scripts/verify-release.ts 1.40.0-chromium --no-store
//   node scripts/verify-release.ts --live android       # the newest Android release
//   node scripts/verify-release.ts 0.31.0-android --apk app-release-unsigned.apk   # your own build
//   node scripts/verify-release.ts --live desktop --arch amd64   # the newest desktop release, Linux
//   node scripts/verify-release.ts --live desktop --macos         # ... its macOS app, on a Mac
//   node scripts/verify-release.ts --live desktop --windows       # ... its Windows installer
//
// Needs git (a clone with the tag), Docker, and network. The builds run as linux/amd64, the release
// runner's platform: the extensions in docker/reproducible-build.Dockerfile, Android in its base
// image with docker/reproducible-android.sh, which keeps the SDK and caches in
// BRAMBLE_VERIFY_CACHE (default ~/.cache/bramble-verify, about 6 GB). See
// docs/reproducible-builds.md for why the platform matters and what each store changes.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, arch as hostArch, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { CWS_ITEM_ID } from "./cws-ids.ts";
import { zeroLinkeditVmsize } from "./macho-normalize.ts";
import { stripAuthenticode } from "./pe-normalize.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = process.env.GITHUB_REPOSITORY ?? "bramble-sh/bramble";
const DOCKERFILE = "docker/reproducible-build.Dockerfile";
const ANDROID_SCRIPT = "docker/reproducible-android.sh";
const DESKTOP_SCRIPT = "docker/reproducible-desktop.sh";
const DESKTOP_DOCKERFILE = "clients/desktop/docker/linux-build.Dockerfile";
const AMO_ID = "firefox@bramble.app";
const AMO_API = "https://addons.mozilla.org/api/v5/addons/addon";
const CWS_CRX =
	"https://clients2.google.com/service/update2/crx?response=redirect&prodversion=999.0" +
	`&acceptformat=crx3&x=${encodeURIComponent(`id=${CWS_ITEM_ID}&uc`)}`;

export type Target = "firefox" | "chromium" | "android" | "desktop";

/** Path inside the package, mapped to its bytes. */
export type Files = Map<string, Buffer>;

/** Path inside the package, mapped to the SHA-256 of its bytes. */
export type Tree = Map<string, string>;

export interface Mismatch {
	path: string;
	problem: "missing" | "extra" | "differs";
}

export function parseTag(tag: string): { version: string; target: Target } {
	const m = /^(\d+\.\d+\.\d+)-(firefox|chromium|android|desktop)$/.exec(tag);
	if (!m) throw new Error(`${tag} is not a release tag this checks (like 1.37.0-firefox)`);
	return { version: m[1], target: m[2] as Target };
}

/**
 * What the GitHub zip leaves out of the build directory: the bundle scripts' `zip -x` list in
 * clients/extension/package.json.
 */
export function inReleaseZip(path: string): boolean {
	const name = path.split("/").pop() ?? path;
	return !(
		path.endsWith(".d.ts") ||
		path === "wasm/package.json" ||
		name === ".gitignore" ||
		name === ".DS_Store"
	);
}

/** An APK's v1 signature files, the only entries signing adds. Releases sign v2+v3 only. */
export function apkSignatureFile(path: string): boolean {
	return path.startsWith("META-INF/") && /\.(SF|RSA|EC|DSA|MF)$/.test(path);
}

/**
 * What a store package carries that the build did not make: AMO's signature in META-INF/, and the
 * Chrome Web Store's _metadata/ (its own hashes of every file). Dotfiles never reach either store.
 */
export function storeAdded(path: string): boolean {
	return path.startsWith("META-INF/") || path.startsWith("_metadata/");
}

/**
 * manifest.json as the store rewrites it: AMO reformats it, and the Chrome Web Store adds
 * update_url. Compared as data, with only that one key allowed to differ.
 */
export function canonicalManifest(bytes: Buffer): string {
	const manifest = JSON.parse(bytes.toString("utf8"));
	delete manifest.update_url;
	return JSON.stringify(sortKeys(manifest));
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
		);
	return value;
}

export function compareTrees(rebuilt: Tree, published: Tree): Mismatch[] {
	const out: Mismatch[] = [];
	for (const [path, hash] of rebuilt) {
		const other = published.get(path);
		if (other === undefined) out.push({ path, problem: "missing" });
		else if (other !== hash) out.push({ path, problem: "differs" });
	}
	for (const path of published.keys()) if (!rebuilt.has(path)) out.push({ path, problem: "extra" });
	return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** The zip inside a CRX3 package: "Cr24", version 3, the header's length, the header, then the zip. */
export function crxZip(crx: Buffer): Buffer {
	if (crx.subarray(0, 4).toString("latin1") !== "Cr24") throw new Error("not a CRX package");
	const version = crx.readUInt32LE(4);
	if (version !== 3) throw new Error(`CRX version ${version}, want 3`);
	return crx.subarray(12 + crx.readUInt32LE(8));
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Every file under `dir`. */
function dirFiles(dir: string): Files {
	const files: Files = new Map();
	const walk = (at: string) => {
		for (const entry of readdirSync(at, { withFileTypes: true })) {
			const full = join(at, entry.name);
			if (entry.isDirectory()) walk(full);
			else files.set(relative(dir, full).split("\\").join("/"), readFileSync(full));
		}
	};
	walk(dir);
	return files;
}

/**
 * Every file in a zip, read from the archive rather than unpacked to disk: a case-insensitive file
 * system (macOS, Windows) merges `res/9n.png` and `res/9N.png`, and an APK's shrunk resource names
 * collide like that, so unpacking would compare fewer files than there are.
 */
export function zipEntries(zip: Buffer): Files {
	let eocd = -1;
	for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--)
		if (zip.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	if (eocd < 0) throw new Error("not a zip archive");
	const count = zip.readUInt16LE(eocd + 10);
	let at = zip.readUInt32LE(eocd + 16);
	if (count === 0xffff || at === 0xffffffff) throw new Error("zip64 archives are not supported");
	const files: Files = new Map();
	for (let n = 0; n < count; n++) {
		if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error("malformed zip central directory");
		const method = zip.readUInt16LE(at + 10);
		const compressed = zip.readUInt32LE(at + 20);
		const size = zip.readUInt32LE(at + 24);
		const nameLength = zip.readUInt16LE(at + 28);
		const local = zip.readUInt32LE(at + 42);
		const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
		at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
		if (name.endsWith("/")) continue;
		if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`malformed zip entry ${name}`);
		const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
		const raw = zip.subarray(start, start + compressed);
		let data: Buffer;
		if (method === 0) data = Buffer.from(raw);
		else if (method === 8) data = inflateRawSync(raw);
		else throw new Error(`${name} uses zip compression method ${method}`);
		if (data.length !== size) throw new Error(`${name} is not the size the archive says`);
		if (files.has(name)) throw new Error(`${name} is in the archive twice`);
		files.set(name, data);
	}
	return files;
}

/** The files `keep` lets through, hashed, manifest.json in its canonical form when asked. */
export function tree(files: Files, keep: (path: string) => boolean, canonical = false): Tree {
	const out: Tree = new Map();
	for (const [path, bytes] of files) {
		if (!keep(path)) continue;
		out.set(
			path,
			canonical && path === "manifest.json"
				? sha256(Buffer.from(canonicalManifest(bytes)))
				: sha256(bytes),
		);
	}
	return out;
}

async function download(url: string): Promise<Buffer> {
	const res = await fetch(url, { redirect: "follow" });
	if (!res.ok) throw new Error(`${url} answered ${res.status}`);
	return Buffer.from(await res.arrayBuffer());
}

/** The version the store serves to a fresh install right now. */
async function liveVersion(target: Target): Promise<string> {
	if (target === "android" || target === "desktop") {
		// Not in a store: the GitHub release is where these ship.
		// With a token where there is one: GitHub limits anonymous calls per IP, and a CI runner
		// shares its IP with everyone else's.
		const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
		const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=50`, {
			headers: token ? { authorization: `Bearer ${token}` } : {},
		});
		if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
		const releases = (await res.json()) as { tag_name: string; draft: boolean }[];
		const latest = releases.find((r) => !r.draft && r.tag_name.endsWith(`-${target}`));
		if (!latest) throw new Error(`no ${target} release found`);
		return latest.tag_name.replace(`-${target}`, "");
	}
	if (target === "firefox") {
		const res = await fetch(`${AMO_API}/${encodeURIComponent(AMO_ID)}/`);
		if (!res.ok) throw new Error(`AMO answered ${res.status}`);
		return (await res.json()).current_version.version;
	}
	const manifest = zipEntries(crxZip(await download(CWS_CRX))).get("manifest.json");
	if (!manifest) throw new Error("the Chrome Web Store package has no manifest.json");
	return JSON.parse(manifest.toString("utf8")).version;
}

/** The store's copy of `version`, or null when the store no longer serves it. */
async function storePackage(target: Target, version: string): Promise<Files | null> {
	if (target === "firefox") {
		const res = await fetch(`${AMO_API}/${encodeURIComponent(AMO_ID)}/versions/${version}/`);
		if (!res.ok) throw new Error(`AMO has no ${version} (${res.status})`);
		const file = (await res.json()).file as { url: string; hash: string };
		const xpi = await download(file.url);
		if (`sha256:${sha256(xpi)}` !== file.hash)
			throw new Error(`the AMO download does not match AMO's own hash for ${version}`);
		return zipEntries(xpi);
	}
	// The Chrome Web Store only ever serves its current version.
	const files = zipEntries(crxZip(await download(CWS_CRX)));
	const served = JSON.parse(files.get("manifest.json")?.toString("utf8") ?? "{}").version;
	return served === version ? files : null;
}

/** The GitHub release's zip or APK, checked against its own SHA256SUMS. */
async function releaseZip(tag: string, target: Target, version: string): Promise<Files> {
	const base = `https://github.com/${REPO}/releases/download/${tag}`;
	const name = `bramble_${target}_${version}.${target === "android" ? "apk" : "zip"}`;
	const zip = await download(`${base}/${name}`);
	const sums = (await download(`${base}/SHA256SUMS`)).toString("utf8");
	const listed = sums.split("\n").find((l) => l.trim().endsWith(` ${name}`));
	if (!listed?.startsWith(sha256(zip)))
		throw new Error(`${name} does not match the release's SHA256SUMS`);
	return zipEntries(zip);
}

/** Unpack the tree `tag` points at into `dir`. No shell: the tag comes from the command line. */
export function extractTag(repo: string, tag: string, dir: string): void {
	let commit: string;
	try {
		commit = execFileSync(
			"git",
			["-C", repo, "rev-parse", "--verify", "--quiet", `${tag}^{commit}`],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		).trim();
	} catch {
		throw new Error(`no tag ${tag} here; run git fetch --tags`);
	}
	const tar = `${dir}.tar`;
	try {
		execFileSync("git", ["-C", repo, "archive", "--format=tar", `--output=${tar}`, commit]);
		execFileSync("tar", ["-x", "-f", tar, "-C", dir]);
	} finally {
		rmSync(tar, { force: true });
	}
}

function rebuild(tag: string, target: Target, scratch: string): Files {
	const src = join(scratch, "src");
	const out = join(scratch, "out");
	mkdirSync(src, { recursive: true });
	mkdirSync(out, { recursive: true });
	extractTag(ROOT, tag, src);
	if (target === "android") return rebuildAndroid(src, out);

	const dockerfile = readFileSync(join(ROOT, DOCKERFILE));
	const image = `bramble-reproducible:${sha256(dockerfile).slice(0, 12)}`;
	const platform = ["--platform", "linux/amd64"];
	execFileSync(
		"docker",
		[
			"build",
			...platform,
			"-t",
			image,
			"-f",
			join(ROOT, DOCKERFILE),
			dirname(join(ROOT, DOCKERFILE)),
		],
		{ stdio: "inherit" },
	);
	const uid = process.getuid?.() ?? 0;
	const gid = process.getgid?.() ?? 0;
	const script = [
		"set -euo pipefail",
		"cp -a /src /build && cd /build",
		"pnpm install --frozen-lockfile",
		"pnpm run wasm:build",
		`pnpm --filter @vault/platform-extension run bundle:${target}`,
		`cp -a clients/extension/dist-${target} /out/dist`,
		`chown -R ${uid}:${gid} /out`,
	].join("\n");
	execFileSync(
		"docker",
		[
			"run",
			"--rm",
			...platform,
			"-v",
			`${src}:/src:ro`,
			"-v",
			`${out}:/out`,
			image,
			"bash",
			"-c",
			script,
		],
		{ stdio: "inherit" },
	);
	return dirFiles(join(out, "dist"));
}

/** Builds in the extension image's own base, pinned by the same digest, with the SDK in a cache. */
function rebuildAndroid(src: string, out: string): Files {
	const base = /^FROM (\S+)/m.exec(readFileSync(join(ROOT, DOCKERFILE), "utf8"))?.[1];
	if (!base) throw new Error(`no FROM line in ${DOCKERFILE}`);
	const cache = process.env.BRAMBLE_VERIFY_CACHE ?? join(homedir(), ".cache/bramble-verify");
	const work = join(cache, "work");
	// Emptied by the container, which runs as root: on a Linux host what it leaves is root's, and
	// removing it from here would be refused.
	mkdirSync(work, { recursive: true });
	execFileSync(
		"docker",
		[
			"run",
			"--rm",
			"--platform",
			"linux/amd64",
			"-v",
			`${src}:/src:ro`,
			"-v",
			`${cache}:/cache`,
			"-v",
			`${work}:/work`,
			"-v",
			`${out}:/out`,
			"-v",
			`${join(ROOT, ANDROID_SCRIPT)}:/verify/build.sh:ro`,
			"-e",
			`HOST_OWNER=${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
			base,
			"bash",
			"/verify/build.sh",
		],
		{ stdio: "inherit" },
	);
	return zipEntries(readFileSync(join(out, "app-release-unsigned.apk")));
}

/** Where a type-2 AppImage's squashfs starts: the end of its ELF runtime's section headers. */
export function appImageOffset(image: Buffer): number {
	if (image.readUInt32BE(0) !== 0x7f454c46) throw new Error("not an ELF file");
	if (image[4] === 2)
		return (
			Number(image.readBigUInt64LE(0x28)) + image.readUInt16LE(0x3a) * image.readUInt16LE(0x3c)
		);
	return image.readUInt32LE(0x20) + image.readUInt16LE(0x2e) * image.readUInt16LE(0x30);
}

/** The paths of lines in one manifest and not the other: a line is hash (or link), mode, path. */
export function manifestDiff(a: string, b: string): string[] {
	const lines = (text: string) => new Set(text.split("\n").filter(Boolean));
	const left = lines(a);
	const right = lines(b);
	const path = (l: string) => l.slice(l.indexOf(" ", l.indexOf(" ") + 1) + 1);
	const differ = [...left]
		.filter((l) => !right.has(l))
		.concat([...right].filter((l) => !left.has(l)));
	return [...new Set(differ.map(path))].sort();
}

type DesktopArch = "amd64" | "arm64";
const DESKTOP_NAMES = {
	amd64: { deb: "amd64", appimage: "amd64", rpm: "x86_64" },
	arm64: { deb: "arm64", appimage: "aarch64", rpm: "aarch64" },
} as const;

/**
 * Rebuild a desktop release's Linux packages for `arch` in the tag's own build image and compare
 * them with the release's. The .deb and AppImage must match to the byte once the tag carries
 * deb-reproducible.ts; before it, and for the RPM always, what they install must match.
 */
async function verifyDesktop(
	tag: string,
	version: string,
	arch: DesktopArch,
	scratch: string,
): Promise<boolean> {
	const src = join(scratch, "src");
	const out = join(scratch, "out");
	const published = join(scratch, "published");
	const manifests = join(scratch, "manifests");
	for (const d of [src, out, published, manifests]) mkdirSync(d, { recursive: true });
	extractTag(ROOT, tag, src);
	const epoch = execFileSync("git", ["-C", ROOT, "log", "-1", "--format=%ct", tag], {
		encoding: "utf8",
	}).trim();
	const strict = existsSync(join(src, "scripts/deb-reproducible.ts"));

	const platform = ["--platform", `linux/${arch}`];
	const image = `bramble-verify-desktop:${version}-${arch}`;
	execFileSync(
		"docker",
		[
			"build",
			...platform,
			"-t",
			image,
			"-f",
			join(src, DESKTOP_DOCKERFILE),
			dirname(join(src, DESKTOP_DOCKERFILE)),
		],
		{ stdio: "inherit" },
	);
	const cache = process.env.BRAMBLE_VERIFY_CACHE ?? join(homedir(), ".cache/bramble-verify");
	const work = join(cache, `work-desktop-${arch}`);
	mkdirSync(work, { recursive: true });
	const script = ["-v", `${join(ROOT, DESKTOP_SCRIPT)}:/verify.sh:ro`];
	execFileSync(
		"docker",
		[
			"run",
			"--rm",
			...platform,
			"--user",
			`${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
			"-e",
			`SOURCE_DATE_EPOCH=${epoch}`,
			"-v",
			`${src}:/src:ro`,
			"-v",
			`${work}:/work`,
			"-v",
			`${out}:/out`,
			...script,
			image,
			"bash",
			"/verify.sh",
			"build",
		],
		{ stdio: "inherit" },
	);

	const names = DESKTOP_NAMES[arch];
	const assets = {
		deb: `Bramble_${version}_${names.deb}.deb`,
		appimage: `Bramble_${version}_${names.appimage}.AppImage`,
		rpm: `Bramble-${version}-1.${names.rpm}.rpm`,
	};
	const base = `https://github.com/${REPO}/releases/download/${tag}`;
	const sums = (await download(`${base}/SHA256SUMS`)).toString("utf8");
	const specs: string[] = [];
	const bytesEqual: Record<string, boolean> = {};
	for (const [kind, name] of Object.entries(assets)) {
		const theirs = await download(`${base}/${name}`);
		if (
			!sums.split("\n").some((l) => l.startsWith(sha256(theirs)) && l.trim().endsWith(` ${name}`))
		)
			throw new Error(`${name} does not match the release's SHA256SUMS`);
		writeFileSync(join(published, name), theirs);
		const ours = join(out, "bundle", kind, name);
		if (!existsSync(ours)) throw new Error(`the rebuild made no ${kind}/${name}`);
		bytesEqual[kind] = sha256(readFileSync(ours)) === sha256(theirs);
		const offset = (file: string) =>
			kind === "appimage" ? `:${appImageOffset(readFileSync(file))}` : "";
		specs.push(`theirs-${kind}=${kind}:/s/published/${name}${offset(join(published, name))}`);
		specs.push(`ours-${kind}=${kind}:/s/out/bundle/${kind}/${name}${offset(ours)}`);
	}
	execFileSync(
		"docker",
		[
			"run",
			"--rm",
			...platform,
			"--user",
			"0:0",
			"-v",
			`${scratch}:/s`,
			...script,
			image,
			"bash",
			"/verify.sh",
			"manifest",
			"/s/manifests",
			...specs,
		],
		{ stdio: ["ignore", "ignore", "inherit"] },
	);

	let ok = true;
	for (const [kind, name] of Object.entries(assets)) {
		const differ = manifestDiff(
			readFileSync(join(manifests, `theirs-${kind}.txt`), "utf8"),
			readFileSync(join(manifests, `ours-${kind}.txt`), "utf8"),
		);
		const files = readFileSync(join(manifests, `ours-${kind}.txt`), "utf8")
			.split("\n")
			.filter(Boolean).length;
		const mustBeBytes = strict && kind !== "rpm";
		if (bytesEqual[kind]) console.log(`  ${name}: byte-identical`);
		else if (!differ.length)
			console.log(`  ${name}: all ${files} files identical; the packaging around them differs`);
		else {
			console.log(`  ${name}: ${differ.length} of ${files} files differ`);
			for (const path of differ.slice(0, 40)) console.log(`    ${path}`);
		}
		if (differ.length || (mustBeBytes && !bytesEqual[kind])) ok = false;
	}
	if (!strict)
		console.log(
			`  (${tag} predates deb-reproducible.ts, so its packages are compared by contents)`,
		);
	return ok;
}

/**
 * Rebuild a desktop release's macOS binaries at the canonical path, as the release did, and compare
 * them with the ones in the published Bramble.app once the code signatures are off both: the
 * release carries Developer ID's, a rebuild only the linker's.
 */
async function verifyDesktopMacos(tag: string, scratch: string): Promise<boolean> {
	if (process.platform !== "darwin") throw new Error("--macos rebuilds on a Mac");
	const src = join(scratch, "src");
	mkdirSync(src, { recursive: true });
	extractTag(ROOT, tag, src);
	if (!existsSync(join(src, "scripts/canonical-path.ts")))
		throw new Error(
			`${tag} predates the canonical build path: its binaries carry the CI runner's own paths and cannot be rebuilt anywhere else`,
		);
	const workflow = readFileSync(join(src, ".github/workflows/desktop-release.yml"), "utf8");
	const xcode = /xcode:[\s\S]*?default: "([^"]+)"/.exec(workflow)?.[1];
	const ours = /Xcode (\S+)/.exec(
		execFileSync("xcodebuild", ["-version"], { encoding: "utf8" }),
	)?.[1];
	if (xcode && ours !== xcode)
		throw new Error(
			`${tag} was built with Xcode ${xcode}; this Mac has ${ours}. The linker shapes the bytes.`,
		);

	execFileSync("pnpm", ["install", "--frozen-lockfile"], { cwd: src, stdio: "inherit" });
	execFileSync(process.execPath, ["scripts/build-macos.ts", "--compile-only", "--canonical"], {
		cwd: src,
		stdio: "inherit",
	});

	const published = join(scratch, "published");
	mkdirSync(published, { recursive: true });
	const base = `https://github.com/${REPO}/releases/download/${tag}`;
	const archive = await download(`${base}/Bramble.app.tar.gz`);
	const sums = (await download(`${base}/SHA256SUMS`)).toString("utf8");
	if (
		!sums
			.split("\n")
			.some((l) => l.startsWith(sha256(archive)) && l.trim().endsWith(" Bramble.app.tar.gz"))
	)
		throw new Error("Bramble.app.tar.gz does not match the release's SHA256SUMS");
	writeFileSync(join(published, "app.tar.gz"), archive);
	execFileSync("tar", ["-xzf", join(published, "app.tar.gz"), "-C", published]);

	const release = join(src, "clients/desktop/src-tauri/target/universal-apple-darwin/release");
	const pairs = [
		[
			"bramble-desktop",
			join(published, "Bramble.app/Contents/MacOS/bramble-desktop"),
			join(release, "bramble-desktop"),
		],
		[
			"bramble-proxy",
			join(published, "Bramble.app/Contents/Helpers/bramble-proxy"),
			join(release, "bramble-proxy"),
		],
	];
	// The AutoFill extension, from the release that first shipped it.
	const autofill = "BrambleAutoFill.appex/Contents/MacOS/BrambleAutoFill";
	if (existsSync(join(published, "Bramble.app/Contents/PlugIns", autofill)))
		pairs.push([
			"BrambleAutoFill",
			join(published, "Bramble.app/Contents/PlugIns", autofill),
			join(src, "clients/desktop/macos/build", autofill),
		]);
	let ok = true;
	for (const [name, theirs, mine] of pairs) {
		const unsigned = (file: string, as: string) => {
			const copy = join(scratch, as);
			writeFileSync(copy, readFileSync(file));
			execFileSync("codesign", ["--remove-signature", copy]);
			return sha256(zeroLinkeditVmsize(readFileSync(copy)));
		};
		const same = unsigned(theirs, `${name}.theirs`) === unsigned(mine, `${name}.ours`);
		console.log(`  ${name}: ${same ? "identical" : "DIFFERS"} once both are unsigned`);
		ok &&= same;
	}
	return ok;
}

/**
 * Rebuild a desktop release's Windows installer in the tag's own container, as sign-windows.yml
 * does, and compare it with the published one once the Authenticode signature is off it.
 */
async function verifyDesktopWindows(
	tag: string,
	version: string,
	scratch: string,
): Promise<boolean> {
	const src = join(scratch, "src");
	mkdirSync(src, { recursive: true });
	extractTag(ROOT, tag, src);
	if (!existsSync(join(src, "clients/desktop/docker/windows-build.Dockerfile")))
		throw new Error(`${tag} predates the container build of the Windows installer`);
	const epoch = execFileSync("git", ["-C", ROOT, "log", "-1", "--format=%ct", tag], {
		encoding: "utf8",
	}).trim();
	const cache = process.env.BRAMBLE_VERIFY_CACHE ?? join(homedir(), ".cache/bramble-verify");
	const work = join(cache, "work-windows");
	mkdirSync(work, { recursive: true });
	execFileSync(process.execPath, ["scripts/build-windows.ts", "--container"], {
		cwd: src,
		stdio: "inherit",
		env: { ...process.env, SOURCE_DATE_EPOCH: epoch, BRAMBLE_WINDOWS_WORK: work },
	});

	const name = `Bramble_${version}_x64-setup.exe`;
	const ours = readFileSync(
		join(src, "clients/desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis", name),
	);
	const base = `https://github.com/${REPO}/releases/download/${tag}`;
	const theirs = await download(`${base}/${name}`);
	const sums = (await download(`${base}/SHA256SUMS`)).toString("utf8");
	if (!sums.split("\n").some((l) => l.startsWith(sha256(theirs)) && l.trim().endsWith(` ${name}`)))
		throw new Error(`${name} does not match the release's SHA256SUMS`);
	const same = sha256(stripAuthenticode(theirs)) === sha256(stripAuthenticode(ours));
	console.log(`  ${name}: ${same ? "identical" : "DIFFERS"} once the signature is off`);
	return same;
}

function report(label: string, mismatches: Mismatch[], count: number): boolean {
	if (!mismatches.length) {
		console.log(`  ${label}: all ${count} files identical`);
		return true;
	}
	console.log(`  ${label}: ${mismatches.length} of ${count} files do not match`);
	for (const m of mismatches) console.log(`    ${m.problem.padEnd(8)} ${m.path}`);
	return false;
}

async function main(argv: string[]): Promise<number> {
	const scratch = mkdtempSync(join(tmpdir(), "bramble-verify-"));
	try {
		let tag = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--apk");
		const live = argv.indexOf("--live");
		if (live !== -1) {
			const target = argv[live + 1] as Target;
			if (!["firefox", "chromium", "android", "desktop"].includes(target))
				throw new Error("--live takes firefox, chromium, android or desktop");
			tag = `${await liveVersion(target)}-${target}`;
			const store = target === "firefox" || target === "chromium";
			console.log(`${store ? "the store is serving" : "the newest release is"} ${tag}`);
		}
		if (!tag)
			throw new Error("usage: verify-release.ts <tag> | --live <firefox|chromium|android|desktop>");
		const { version, target } = parseTag(tag);
		if (target === "desktop" && argv.includes("--windows")) {
			const ok = await verifyDesktopWindows(tag, version, scratch);
			console.log(ok ? "\nreproducible" : "\nNOT reproducible");
			return ok ? 0 : 1;
		}
		if (target === "desktop" && argv.includes("--macos")) {
			const ok = await verifyDesktopMacos(tag, scratch);
			console.log(ok ? "\nreproducible" : "\nNOT reproducible");
			return ok ? 0 : 1;
		}
		if (target === "desktop") {
			const archAt = argv.indexOf("--arch");
			const arch = archAt === -1 ? (hostArch() === "arm64" ? "arm64" : "amd64") : argv[archAt + 1];
			if (arch !== "amd64" && arch !== "arm64") throw new Error("--arch takes amd64 or arm64");
			const ok = await verifyDesktop(tag, version, arch, scratch);
			console.log(ok ? "\nreproducible" : "\nNOT reproducible");
			return ok ? 0 : 1;
		}

		const apkAt = argv.indexOf("--apk");
		let built: Files;
		if (apkAt !== -1) {
			if (target !== "android") throw new Error("--apk is for Android tags");
			built = zipEntries(readFileSync(resolve(argv[apkAt + 1] ?? "")));
		} else {
			built = rebuild(tag, target, scratch);
		}
		if (target === "android") {
			const fromRelease = await releaseZip(tag, target, version);
			const keep = (p: string) => !apkSignatureFile(p);
			const ours = tree(built, keep);
			const ok = report(
				"GitHub release APK (signature aside)",
				compareTrees(ours, tree(fromRelease, keep)),
				ours.size,
			);
			console.log(ok ? "\nreproducible" : "\nNOT reproducible");
			return ok ? 0 : 1;
		}
		const wasm = built.get("wasm/vault_crypto_bg.wasm");
		if (!wasm) throw new Error("the build has no wasm/vault_crypto_bg.wasm");
		console.log(`\nrebuilt ${tag}; vault_crypto_bg.wasm sha256 ${sha256(wasm)}`);

		const fromRelease = await releaseZip(tag, target, version);
		const zipTree = tree(built, inReleaseZip);
		let ok = report(
			"GitHub release zip",
			compareTrees(
				zipTree,
				tree(fromRelease, () => true),
			),
			zipTree.size,
		);

		if (!argv.includes("--no-store")) {
			const store = target === "firefox" ? "addons.mozilla.org" : "the Chrome Web Store";
			const fromStore = await storePackage(target, version);
			if (fromStore) {
				const notDot = (p: string) => !(p.split("/").pop() ?? p).startsWith(".");
				const ours = tree(built, notDot, true);
				const served = tree(fromStore, (p) => notDot(p) && !storeAdded(p), true);
				ok = report(store, compareTrees(ours, served), ours.size) && ok;
			} else {
				console.log(`  ${store}: no longer serves ${version}; --live checks what it serves now`);
			}
		}
		console.log(ok ? "\nreproducible" : "\nNOT reproducible");
		return ok ? 0 : 1;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(e: Error) => {
			console.error(`error: ${e.message}`);
			process.exit(2);
		},
	);
}
