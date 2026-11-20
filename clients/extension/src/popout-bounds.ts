// Firefox keeps one saved size and position for all of its windows, and a pop-out writes its own
// there whenever it moves or resizes, so the next window Firefox opened with none open (a link
// from another app) came up pop-out sized (#225). Once the pop-out's bounds stop changing, it asks
// the background to have a normal window save its own again (POPOUT_BOUNDS_SETTLED).

/** Past Firefox's half-second delay before it saves a window's bounds. */
const SETTLE_MS = 1_500;
/** There is no event for a window moving, so its position is polled. */
const POLL_MS = 500;

type Bounds = Pick<Window, "screenX" | "screenY" | "outerWidth" | "outerHeight">;

/** Call `settled` once the bounds of `win` stop changing, and after each later change. Returns a stop function. */
export function watchPopoutBounds(win: Bounds, settled: () => void): () => void {
	const read = () => `${win.screenX},${win.screenY},${win.outerWidth},${win.outerHeight}`;
	let last = read();
	// Armed at once: the bounds the background sets right after creating the window count too.
	let timer = setTimeout(settled, SETTLE_MS);
	const poll = setInterval(() => {
		const now = read();
		if (now === last) return;
		last = now;
		clearTimeout(timer);
		timer = setTimeout(settled, SETTLE_MS);
	}, POLL_MS);
	return () => {
		clearInterval(poll);
		clearTimeout(timer);
	};
}
