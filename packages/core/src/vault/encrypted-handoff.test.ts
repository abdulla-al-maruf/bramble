import { describe, expect, it, vi } from "vitest";
import { drainHandoff } from "./encrypted-handoff";

const rec = (ciphertext: string) => ({ iv: "IV", ciphertext });

describe("drainHandoff", () => {
	it("decrypts each record, and puts back what another vault sealed", async () => {
		const restore = vi.fn(async () => {});
		const out = await drainHandoff(
			{ consume: async () => ({ pending: [rec("mine"), rec("theirs")] }), restore },
			async (_iv, ct) => {
				if (ct === "theirs") throw new Error("aead");
				return JSON.stringify({ id: ct });
			},
			(json) => json as { id: string },
		);
		expect(out).toEqual([{ id: "mine" }]);
		expect(restore).toHaveBeenCalledWith({ keep: [rec("theirs")] });
	});

	it("drops a record that decrypts but no vault could use", async () => {
		const restore = vi.fn(async () => {});
		const out = await drainHandoff(
			{ consume: async () => ({ pending: [rec("junk")] }), restore },
			async () => "not json",
			(json) => json,
		);
		expect(out).toEqual([]);
		expect(restore).not.toHaveBeenCalled();
	});

	it("answers nothing when the native side can't be read", async () => {
		const out = await drainHandoff(
			{ consume: async () => Promise.reject(new Error("gone")), restore: async () => {} },
			async () => "{}",
			(json) => json,
		);
		expect(out).toEqual([]);
	});
});
