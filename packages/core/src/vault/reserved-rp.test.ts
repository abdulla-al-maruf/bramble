import { describe, expect, it } from "vitest";
import { isReservedRpId, UNLOCK_RP_ID } from "./reserved-rp";

describe("isReservedRpId", () => {
	it("reserves bramble.sh in any case and with a trailing dot", () => {
		expect(UNLOCK_RP_ID).toBe("bramble.sh");
		for (const rp of ["bramble.sh", "BRAMBLE.SH", "bramble.sh."])
			expect(isReservedRpId(rp)).toBe(true);
	});

	it("leaves subdomains and lookalikes alone", () => {
		for (const rp of ["mailbox.bramble.sh", "notbramble.sh", "bramble.sh.evil.com", ""])
			expect(isReservedRpId(rp)).toBe(false);
	});
});
