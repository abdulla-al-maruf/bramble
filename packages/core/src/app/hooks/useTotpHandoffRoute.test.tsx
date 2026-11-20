/** @vitest-environment happy-dom */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearPendingTotp, takePendingTotp } from "../pending-totp";
import { type TotpHandoff, useTotpHandoffRoute } from "./useTotpHandoffRoute";

const URI = "otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub";

function setup(handoff: TotpHandoff | undefined, open: boolean) {
	const go = vi.fn();
	const hook = renderHook(
		({ handoff, open }: { handoff: TotpHandoff | undefined; open: boolean }) =>
			useTotpHandoffRoute(handoff, open, go),
		{ initialProps: { handoff, open } },
	);
	return { go, rerender: hook.rerender };
}

beforeEach(() => clearPendingTotp());

describe("useTotpHandoffRoute", () => {
	it("parks the key and opens the setup screen", () => {
		const { go } = setup({ uri: URI }, true);
		expect(go).toHaveBeenCalledTimes(1);
		expect(takePendingTotp()).toBe(URI);
	});

	it("waits for the vault to unlock", () => {
		const handoff = { uri: URI };
		const { go, rerender } = setup(handoff, false);
		expect(go).not.toHaveBeenCalled();
		rerender({ handoff, open: true });
		expect(go).toHaveBeenCalledTimes(1);
	});

	// The shell keeps the last handoff, so every unlock would otherwise reopen the screen.
	it("does not reopen the screen for the same arrival after a lock", () => {
		const handoff = { uri: URI };
		const { go, rerender } = setup(handoff, true);
		rerender({ handoff, open: false });
		rerender({ handoff, open: true });
		expect(go).toHaveBeenCalledTimes(1);
	});

	// Opening the same setup link twice is two arrivals, not a replay.
	it("opens the screen again when the same link arrives again", () => {
		const { go, rerender } = setup({ uri: URI }, true);
		takePendingTotp();
		rerender({ handoff: { uri: URI }, open: true });
		expect(go).toHaveBeenCalledTimes(2);
		expect(takePendingTotp()).toBe(URI);
	});
});
