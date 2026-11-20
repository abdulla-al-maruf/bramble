import { describe, expect, it } from "vitest";
import { EncryptedEntrySchema } from "./vault-format";

const base = {
	id: "e",
	wrappedDek: "w",
	dekIv: "d",
	ciphertext: "c",
	iv: "i",
	hlc: { wall: 1, counter: 0, node: "a" },
};

describe("EncryptedEntrySchema localOnly", () => {
	it("keeps the flag through a parse", () => {
		expect(EncryptedEntrySchema.parse({ ...base, localOnly: true }).localOnly).toBe(true);
	});

	it("still parses an envelope written before the flag existed", () => {
		expect(EncryptedEntrySchema.parse(base).localOnly).toBeUndefined();
	});
});
