import { beforeEach, describe, expect, it } from "vitest";
import { clearPendingTotp, onPendingTotp, setPendingTotp, takePendingTotp } from "./pending-totp";

const URI = "otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub";

beforeEach(() => {
	clearPendingTotp();
});

describe("the handed-over key", () => {
	it("is empty until one arrives", () => {
		expect(takePendingTotp()).toBeNull();
	});

	// One-shot: backing out of the setup screen must discard the seed rather than leave it
	// waiting for the next visit.
	it("is taken once", () => {
		setPendingTotp(URI);
		expect(takePendingTotp()).toBe(URI);
		expect(takePendingTotp()).toBeNull();
	});

	it("can be dropped without being used", () => {
		setPendingTotp(URI);
		clearPendingTotp();
		expect(takePendingTotp()).toBeNull();
	});

	it("keeps only the most recent arrival", () => {
		setPendingTotp("otpauth://totp/old?secret=JBSWY3DPEHPK3PXP");
		setPendingTotp(URI);
		expect(takePendingTotp()).toBe(URI);
	});
});

// The setup screen takes its key when it opens, so one already open has to hear of the next.
describe("a key arriving while the setup screen is open", () => {
	it("reaches it, and nothing after it stops listening", () => {
		let heard = 0;
		const stop = onPendingTotp(() => heard++);
		setPendingTotp(URI);
		expect(heard).toBe(1);
		stop();
		setPendingTotp(URI);
		expect(heard).toBe(1);
	});
});
