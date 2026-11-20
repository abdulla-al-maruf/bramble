import type { LoginEntry } from "../../../hooks/useVault";
import { withScheme } from "../../../util/url";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function host(url: string): string {
	try {
		return new URL(withScheme(url.trim())).hostname;
	} catch {
		return "";
	}
}

/**
 * The live logins a handed-over key most likely belongs to: its issuer in the login's name or a
 * website's host, the one with the key's account first. Nothing from the account alone, since
 * most people use one email everywhere.
 */
export function suggestedLogins(
	entries: LoginEntry[],
	issuer: string,
	account: string,
): LoginEntry[] {
	const want = norm(issuer);
	if (!want) return [];
	// A short issuer ("X") has to be the whole name or host label, or it matches half the vault.
	const matches = (text: string) =>
		want.length < 3
			? text
					.toLowerCase()
					.split(/[^a-z0-9]+/)
					.includes(want)
			: norm(text).includes(want);
	const mine = account.trim().toLowerCase();
	return entries
		.filter((e) => e.archivedAt === undefined)
		.filter((e) => matches(e.name) || e.urls.some((u) => matches(host(u))))
		.sort(
			(a, b) =>
				Number(Boolean(mine) && b.username.toLowerCase() === mine) -
				Number(Boolean(mine) && a.username.toLowerCase() === mine),
		);
}
