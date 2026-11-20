// node --test scripts/verify-release.test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { deflateRawSync } from "node:zlib";
import {
	apkSignatureFile,
	appImageOffset,
	canonicalManifest,
	compareTrees,
	crxZip,
	extractTag,
	inReleaseZip,
	manifestDiff,
	parseTag,
	storeAdded,
	tree,
	zipEntries,
} from "./verify-release.ts";

describe("parseTag", () => {
	it("reads the version and target of an extension tag", () => {
		assert.deepEqual(parseTag("1.37.0-firefox"), { version: "1.37.0", target: "firefox" });
		assert.deepEqual(parseTag("1.40.0-chromium"), { version: "1.40.0", target: "chromium" });
		assert.deepEqual(parseTag("0.31.0-android"), { version: "0.31.0", target: "android" });
		assert.deepEqual(parseTag("0.19.0-desktop"), { version: "0.19.0", target: "desktop" });
	});

	it("refuses tags it cannot check", () => {
		assert.throws(() => parseTag("1.26.0-build216864987-ios"));
		assert.throws(() => parseTag("1.37.0-firefox-rc"));
	});
});

describe("compareTrees", () => {
	it("is empty when both trees hold the same bytes", () => {
		const tree = new Map([
			["a.js", "1"],
			["wasm/x.wasm", "2"],
		]);
		assert.deepEqual(compareTrees(tree, new Map(tree)), []);
	});

	it("names files missing, extra, and different", () => {
		const rebuilt = new Map([
			["a.js", "1"],
			["b.js", "2"],
		]);
		const published = new Map([
			["a.js", "X"],
			["c.js", "3"],
		]);
		assert.deepEqual(compareTrees(rebuilt, published), [
			{ path: "a.js", problem: "differs" },
			{ path: "b.js", problem: "missing" },
			{ path: "c.js", problem: "extra" },
		]);
	});
});

describe("what each published copy leaves out or adds", () => {
	it("leaves the zip's exclusions out of the zip comparison", () => {
		assert.equal(inReleaseZip("wasm/vault_crypto.d.ts"), false);
		assert.equal(inReleaseZip("wasm/package.json"), false);
		assert.equal(inReleaseZip("wasm/.gitignore"), false);
		assert.equal(inReleaseZip("wasm/vault_crypto_bg.wasm"), true);
		assert.equal(inReleaseZip("package.json"), true);
	});

	it("sets aside only an APK's v1 signature files", () => {
		assert.equal(apkSignatureFile("META-INF/CERT.RSA"), true);
		assert.equal(apkSignatureFile("META-INF/MANIFEST.MF"), true);
		assert.equal(apkSignatureFile("META-INF/androidx.core_core.version"), false);
		assert.equal(apkSignatureFile("classes.dex"), false);
	});

	it("allows only the stores' own signature folders", () => {
		assert.equal(storeAdded("META-INF/cose.sig"), true);
		assert.equal(storeAdded("_metadata/verified_contents.json"), true);
		assert.equal(storeAdded("background.js"), false);
	});
});

describe("canonicalManifest", () => {
	it("ignores formatting and the Chrome Web Store's update_url", () => {
		const ours = Buffer.from('{\n\t"version": "1.0.0",\n\t"name": "Bramble"\n}\n');
		const store = Buffer.from(
			'{"name":"Bramble","update_url":"https://clients2.google.com/service/update2/crx","version":"1.0.0"}',
		);
		assert.equal(canonicalManifest(ours), canonicalManifest(store));
	});

	it("still sees any other change", () => {
		const ours = Buffer.from('{"version":"1.0.0","permissions":["storage"]}');
		const store = Buffer.from('{"version":"1.0.0","permissions":["storage","tabs"]}');
		assert.notEqual(canonicalManifest(ours), canonicalManifest(store));
	});
});

describe("crxZip", () => {
	it("returns the zip after a CRX3 header", () => {
		const header = Buffer.from("proto-header");
		const zip = Buffer.from("PK\u0003\u0004rest");
		const prefix = Buffer.alloc(12);
		prefix.write("Cr24", 0, "latin1");
		prefix.writeUInt32LE(3, 4);
		prefix.writeUInt32LE(header.length, 8);
		assert.deepEqual(crxZip(Buffer.concat([prefix, header, zip])), zip);
	});

	it("refuses anything that is not CRX3", () => {
		assert.throws(() => crxZip(Buffer.from("PK\u0003\u0004")));
		const v2 = Buffer.alloc(12);
		v2.write("Cr24", 0, "latin1");
		v2.writeUInt32LE(2, 4);
		assert.throws(() => crxZip(v2));
	});
});

/** A zip of `entries`, stored or deflated, written by hand so names may differ only in case. */
function zipOf(entries: [string, string, "store" | "deflate"][]): Buffer {
	const locals: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const [name, text, how] of entries) {
		const data = Buffer.from(text);
		const body = how === "deflate" ? deflateRawSync(data) : data;
		const nameBytes = Buffer.from(name);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(how === "deflate" ? 8 : 0, 8);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		const dir = Buffer.alloc(46);
		dir.writeUInt32LE(0x02014b50, 0);
		dir.writeUInt16LE(how === "deflate" ? 8 : 0, 10);
		dir.writeUInt32LE(body.length, 20);
		dir.writeUInt32LE(data.length, 24);
		dir.writeUInt16LE(nameBytes.length, 28);
		dir.writeUInt32LE(offset, 42);
		locals.push(local, nameBytes, body);
		central.push(dir, nameBytes);
		offset += 30 + nameBytes.length + body.length;
	}
	const centralBytes = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralBytes.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, centralBytes, end]);
}

describe("zipEntries", () => {
	it("reads stored and deflated entries, keeping names that differ only in case apart", () => {
		const files = zipEntries(
			zipOf([
				["res/9n.png", "lower", "store"],
				["res/9N.png", "upper", "deflate"],
				["classes.dex", "dex".repeat(100), "deflate"],
			]),
		);
		assert.equal(files.size, 3);
		assert.equal(files.get("res/9n.png")?.toString(), "lower");
		assert.equal(files.get("res/9N.png")?.toString(), "upper");
		assert.equal(files.get("classes.dex")?.toString(), "dex".repeat(100));
	});

	it("so a change to one of a case-colliding pair is seen", () => {
		const a = tree(
			zipEntries(
				zipOf([
					["r/a", "1", "store"],
					["r/A", "2", "store"],
				]),
			),
			() => true,
		);
		const b = tree(
			zipEntries(
				zipOf([
					["r/a", "1", "store"],
					["r/A", "X", "store"],
				]),
			),
			() => true,
		);
		assert.deepEqual(compareTrees(a, b), [{ path: "r/A", problem: "differs" }]);
	});

	it("refuses an archive that names a file twice", () => {
		assert.throws(
			() =>
				zipEntries(
					zipOf([
						["x", "1", "store"],
						["x", "2", "store"],
					]),
				),
			/twice/,
		);
	});

	it("refuses what is not a zip", () => {
		assert.throws(
			() => zipEntries(Buffer.from("not a zip at all, just some bytes here")),
			/not a zip/,
		);
	});
});

describe("appImageOffset", () => {
	it("is the end of the runtime's section headers, for 64-bit and 32-bit ELF", () => {
		const elf64 = Buffer.alloc(64);
		elf64.writeUInt32BE(0x7f454c46, 0);
		elf64[4] = 2;
		elf64.writeBigUInt64LE(935_176n, 0x28);
		elf64.writeUInt16LE(64, 0x3a);
		elf64.writeUInt16LE(20, 0x3c);
		assert.equal(appImageOffset(elf64), 935_176 + 64 * 20);
		const elf32 = Buffer.alloc(52);
		elf32.writeUInt32BE(0x7f454c46, 0);
		elf32[4] = 1;
		elf32.writeUInt32LE(1000, 0x20);
		elf32.writeUInt16LE(40, 0x2e);
		elf32.writeUInt16LE(5, 0x30);
		assert.equal(appImageOffset(elf32), 1200);
	});

	it("refuses what is not an ELF file", () => {
		assert.throws(() => appImageOffset(Buffer.alloc(64)));
	});
});

describe("manifestDiff", () => {
	it("names paths whose hash, mode or link differ, or that one side lacks", () => {
		const theirs =
			"aa 755 usr/bin/bramble\nbb 644 usr/share/x\nlink:a 777 usr/lib/l\ncc 644 gone\n";
		const ours = "aa 755 usr/bin/bramble\nbb 600 usr/share/x\nlink:b 777 usr/lib/l\ndd 644 new\n";
		assert.deepEqual(manifestDiff(theirs, ours), ["gone", "new", "usr/lib/l", "usr/share/x"]);
	});

	it("keeps paths with spaces whole", () => {
		assert.deepEqual(manifestDiff("aa 644 a b/c d\n", "aa 644 a b/c d\n"), []);
	});
});

describe("extractTag", () => {
	const scratch = mkdtempSync(join(tmpdir(), "verify-release-test-"));
	const repo = join(scratch, "repo");
	mkdirSync(repo);
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
	git("init", "-q");
	writeFileSync(join(repo, "kept.txt"), "tagged\n");
	git("add", ".");
	git("commit", "-qm", "one");
	git("tag", "1.0.0-desktop");
	writeFileSync(join(repo, "later.txt"), "after the tag\n");
	git("add", ".");
	git("commit", "-qm", "two");

	it("unpacks the tree the tag points at", () => {
		const dir = join(scratch, "src");
		mkdirSync(dir);
		extractTag(repo, "1.0.0-desktop", dir);
		assert.equal(readFileSync(join(dir, "kept.txt"), "utf8"), "tagged\n");
		assert.equal(existsSync(join(dir, "later.txt")), false);
		assert.equal(existsSync(`${dir}.tar`), false);
	});

	it("refuses a tag that is not there, and never hands it to a shell", () => {
		const dir = join(scratch, "hostile");
		mkdirSync(dir);
		const marker = join(scratch, "ran");
		assert.throws(() => extractTag(repo, `x"; touch "${marker}"; echo "`, dir), /no tag/);
		assert.equal(existsSync(marker), false);
	});

	process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
});
