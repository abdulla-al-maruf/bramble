// node --test scripts/macos-handoff.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { macosHandoff } from "./macos-handoff.ts";

describe("macosHandoff", () => {
	it("hands over the AutoFill extension, checking only its binary as universal", () => {
		const { binaries, files } = macosHandoff("release-out");
		const appex = "macos/build/BrambleAutoFill.appex/Contents";
		assert.ok(binaries.includes(`${appex}/MacOS/BrambleAutoFill`));
		assert.ok(files.includes(`${appex}/Info.plist`));
		assert.ok(!binaries.includes(`${appex}/Info.plist`));
		for (const b of binaries) assert.ok(files.includes(b), b);
	});

	it("keeps every path inside the root, which tar requires on the way back", () => {
		const { root, files } = macosHandoff("release-out");
		assert.equal(root, "clients/desktop");
		for (const f of files) assert.ok(!f.startsWith("/") && !f.split("/").includes(".."), f);
	});
});
