import { describe, expect, it } from "vitest";
import type { Entry } from "../hooks/useVault";
import { visibleEntries } from "./visible";

describe("visibleEntries", () => {
	it("keeps every kind a person sees and drops the unlock key", () => {
		const entries = [
			{ id: "l", type: "login" },
			{ id: "c", type: "card" },
			{ id: "n", type: "note" },
			{ id: "s", type: "ssh-key" },
			{ id: "u", type: "unlock-key" },
		] as unknown as Entry[];
		expect(visibleEntries(entries).map((e) => e.id)).toEqual(["l", "c", "n", "s"]);
	});
});
