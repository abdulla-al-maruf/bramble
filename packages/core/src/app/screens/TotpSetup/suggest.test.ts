import { describe, expect, it } from "vitest";
import type { LoginEntry } from "../../../hooks/useVault";
import { suggestedLogins } from "./suggest";

const login = (id: string, fields: Partial<LoginEntry> = {}): LoginEntry => ({
	id,
	type: "login",
	name: id,
	urls: [],
	username: "",
	password: "",
	...fields,
});

const ids = (entries: LoginEntry[]) => entries.map((e) => e.id);

describe("suggestedLogins", () => {
	it("finds the site by name or by a website's host, ignoring case and punctuation", () => {
		const entries = [
			login("a", { name: "GitHub" }),
			login("b", { name: "Work", urls: ["https://github.com/login"] }),
			login("c", { name: "Git Lab", urls: ["gitlab.com"] }),
			login("d", { name: "Bank" }),
		];
		expect(ids(suggestedLogins(entries, "GitHub", ""))).toEqual(["a", "b"]);
		expect(ids(suggestedLogins(entries, "gitlab", ""))).toEqual(["c"]);
	});

	it("puts the login with the key's account first", () => {
		const entries = [
			login("other", { name: "GitHub", username: "someone" }),
			login("mine", { name: "GitHub", username: "Octocat" }),
		];
		expect(ids(suggestedLogins(entries, "GitHub", "octocat"))).toEqual(["mine", "other"]);
	});

	// Most people use one email everywhere, so the account alone would suggest every login.
	it("suggests nothing from the account alone", () => {
		const entries = [login("a", { name: "Shop", username: "me@example.com" })];
		expect(suggestedLogins(entries, "", "me@example.com")).toEqual([]);
	});

	// "X" is in half the names in a vault.
	it("needs a short issuer to match a name or host exactly", () => {
		const entries = [login("x", { name: "X", urls: ["x.com"] }), login("box", { name: "Dropbox" })];
		expect(ids(suggestedLogins(entries, "X", ""))).toEqual(["x"]);
	});

	it("skips archived logins", () => {
		const entries = [login("a", { name: "GitHub", archivedAt: 1 })];
		expect(suggestedLogins(entries, "GitHub", "")).toEqual([]);
	});
});
