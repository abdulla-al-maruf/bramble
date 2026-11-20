import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchPopoutBounds } from "./popout-bounds";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const bounds = () => ({ screenX: 10, screenY: 20, outerWidth: 500, outerHeight: 600 });

describe("watchPopoutBounds (#225)", () => {
	it("reports once after opening, for the bounds the window was given", () => {
		const settled = vi.fn();
		watchPopoutBounds(bounds(), settled);
		vi.advanceTimersByTime(1_499);
		expect(settled).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(settled).toHaveBeenCalledOnce();
		vi.advanceTimersByTime(10_000);
		expect(settled).toHaveBeenCalledOnce();
	});

	it("waits for a move or resize to stop, then reports once", () => {
		const win = bounds();
		const settled = vi.fn();
		watchPopoutBounds(win, settled);
		vi.advanceTimersByTime(2_000);
		settled.mockClear();
		for (let i = 0; i < 6; i++) {
			win.screenX += 5;
			win.outerWidth += 3;
			vi.advanceTimersByTime(500);
		}
		expect(settled).not.toHaveBeenCalled();
		vi.advanceTimersByTime(2_000);
		expect(settled).toHaveBeenCalledOnce();
	});

	it("stops when asked", () => {
		const win = bounds();
		const settled = vi.fn();
		const stop = watchPopoutBounds(win, settled);
		stop();
		win.screenY = 99;
		vi.advanceTimersByTime(10_000);
		expect(settled).not.toHaveBeenCalled();
	});
});
