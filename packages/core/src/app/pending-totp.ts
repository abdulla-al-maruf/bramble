// An `otpauth://` key in flight, between the OS handing it over and the setup screen taking
// it. One-shot, and module-level (not React state) so it survives the navigation that delivers
// it. See docs/totp-uri-handler.md.
//
// Memory only, never persisted: the URI carries the shared TOTP seed.

let handoff: string | null = null;

const listeners = new Set<() => void>();

/** Park a key the OS handed over, for the setup screen to pick up. */
export function setPendingTotp(uri: string): void {
	handoff = uri;
	for (const listener of listeners) listener();
}

/** Hear of a key parked while the setup screen is already open. Returns an unsubscribe. */
export function onPendingTotp(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Take the handed-over key, if any. Consumed once, so backing out of setup discards it. */
export function takePendingTotp(): string | null {
	const u = handoff;
	handoff = null;
	return u;
}

/** Drop a parked key without using it. */
export function clearPendingTotp(): void {
	handoff = null;
}
