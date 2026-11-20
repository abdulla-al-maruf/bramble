// What the macOS compile job hands the signing job (scripts/release.ts): the lipo'd app binary,
// the proxy in both places a universal build needs it (stage-proxy.mjs says why there are two),
// and the unsigned AutoFill extension, which build-macos.ts signs. Relative to `root`, with no
// `..`, because tar will not extract one.

import { join } from "node:path";

const APPEX = "macos/build/BrambleAutoFill.appex/Contents";

export function macosHandoff(handoffDir: string): {
	root: string;
	tarball: string;
	/** Must arrive executable and universal. */
	binaries: string[];
	/** Everything packed, binaries included. */
	files: string[];
} {
	const binaries = [
		"src-tauri/target/universal-apple-darwin/release/bramble-desktop",
		"src-tauri/target/universal-apple-darwin/release/bramble-proxy",
		"src-tauri/binaries/bramble-proxy-universal-apple-darwin",
		`${APPEX}/MacOS/BrambleAutoFill`,
	];
	return {
		root: "clients/desktop",
		tarball: join(handoffDir, "macos-universal.tar"),
		binaries,
		files: [...binaries, `${APPEX}/Info.plist`],
	};
}
