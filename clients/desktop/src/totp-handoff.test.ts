import { beforeEach, describe, expect, it, vi } from "vitest";

// A stand-in for the shell's park (src-tauri/src/otpauth.rs): one key, taken once.
const h = vi.hoisted(() => ({
	parked: null as string | null,
	listeners: new Map<string, () => void>(),
	missing: false,
}));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: async (cmd: string) => {
		if (cmd !== "totp_handoff_take") throw new Error(`unexpected ${cmd}`);
		if (h.missing) throw new Error("command totp_handoff_take not found");
		const uri = h.parked;
		h.parked = null;
		return uri;
	},
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: async (name: string, cb: () => void) => {
		h.listeners.set(name, cb);
		return () => h.listeners.delete(name);
	},
}));

const { onTotpHandoff, resetForTest } = await import("./totp-handoff");

const OTPAUTH = "otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub";

beforeEach(() => {
	h.parked = null;
	h.listeners.clear();
	h.missing = false;
	resetForTest();
});

describe("onTotpHandoff", () => {
	it("takes a key that arrived before the window listened", async () => {
		h.parked = OTPAUTH;
		const cb = vi.fn();
		onTotpHandoff(cb);
		await vi.waitFor(() => expect(cb).toHaveBeenCalledWith(OTPAUTH));
		expect(h.parked).toBeNull();
	});

	it("takes a key when the shell says one is waiting", async () => {
		const cb = vi.fn();
		onTotpHandoff(cb);
		await vi.waitFor(() => expect(h.listeners.has("totp-handoff")).toBe(true));
		h.parked = OTPAUTH;
		h.listeners.get("totp-handoff")?.();
		await vi.waitFor(() => expect(cb).toHaveBeenCalledWith(OTPAUTH));
		expect(cb).toHaveBeenCalledTimes(1);
	});

	// React's dev double mount unsubscribes before the first take resolves. The shell has already
	// handed the key over, so dropping it here would lose it.
	it("keeps a key taken after its subscriber left, for the next one", async () => {
		h.parked = OTPAUTH;
		const first = vi.fn();
		onTotpHandoff(first)();
		await vi.waitFor(() => expect(h.parked).toBeNull());
		expect(first).not.toHaveBeenCalled();

		const second = vi.fn();
		onTotpHandoff(second);
		expect(second).toHaveBeenCalledWith(OTPAUTH);
		expect(second).toHaveBeenCalledTimes(1);
	});

	it("ignores anything that is not an otpauth key", async () => {
		h.parked = "https://bramble.sh";
		const cb = vi.fn();
		onTotpHandoff(cb);
		await vi.waitFor(() => expect(h.parked).toBeNull());
		expect(cb).not.toHaveBeenCalled();
	});

	it("does nothing where the shell has no such command", async () => {
		h.missing = true;
		const cb = vi.fn();
		expect(() => onTotpHandoff(cb)).not.toThrow();
		await new Promise((r) => setTimeout(r, 0));
		expect(cb).not.toHaveBeenCalled();
	});
});
