import type { Entry } from "../hooks/useVault";

/** What a person can see: every entry but the browser extension's hidden unlock key. */
export function visibleEntries<T extends Pick<Entry, "type">>(entries: readonly T[]): T[] {
	return entries.filter((e) => e.type !== "unlock-key");
}
