import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// An `otpauth://` key macOS hands Bramble when it is the app picked under Set Up Codes In. The
// shell parks it and only signals that one is waiting, so the seed never rides an event; this
// window takes it. Taking it on mount covers a cold launch, where the URL arrived before anything
// listened. See src-tauri/src/otpauth.rs and docs/totp-uri-handler.md, Phase 4.

const SCHEME = /^otpauth:\/\//i;

// Taken from the shell after its subscriber went away: kept for the next one, since the shell no
// longer has it.
let unclaimed: string | null = null;

/** Subscribe to handed-over authenticator keys. Returns an unsubscribe. */
export function onTotpHandoff(cb: (uri: string) => void): () => void {
	let live = true;
	const take = () =>
		void invoke<string | null>("totp_handoff_take")
			.then((uri) => {
				if (!uri || !SCHEME.test(uri)) return;
				if (live) cb(uri);
				else unclaimed = uri;
			})
			// Not macOS: the command does not exist.
			.catch(() => {});

	const stop = listen("totp-handoff", take);
	if (unclaimed) {
		cb(unclaimed);
		unclaimed = null;
	}
	take();
	return () => {
		live = false;
		void stop.then((unlisten) => unlisten()).catch(() => {});
	};
}

/** Test seam. */
export function resetForTest(): void {
	unclaimed = null;
}
