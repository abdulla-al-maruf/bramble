#!/usr/bin/env node
// #225: Firefox keeps one saved size and position for all of its windows, and moving or resizing
// the pop-out overwrote it, so the next window Firefox opened with none open came up pop-out
// sized. Moves the pop-out the way a user would, then reads what Firefox saved (xulstore.json)
// once it has quit. Run it HEADED=1: a headless window does not save its bounds the same way.
//
// Manual, not CI: it wants a stock Firefox (see driver.mjs). Build first:
//
//   pnpm --filter @vault/platform-extension build:firefox
//   HEADED=1 FIREFOX_BINARY=/path/to/firefox node e2e/firefox/popout-bounds.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { launch, OPENER_PAGE, serve, sleep, waitFor } from "./driver.mjs";

const ALL = `browser.windows.getAll().then((ws) => ws.map((w) => ({ id: w.id, type: w.type, left: w.left, top: w.top, width: w.width, height: w.height })))`;

const server = await serve({ "*": { body: OPENER_PAGE } });
const firefox = await launch();
let failed = 0;
let main;
let saved;
try {
	const [tab] = (await firefox.contexts()).map((c) => c.context);
	const options = await firefox.openExtensionPage(tab, `http://localhost:${server.port}/`, "options.html");
	[main] = await firefox.evaluate(options, ALL);
	await firefox.evaluate(options, `browser.runtime.sendMessage({ type: "POPOUT_OPEN", payload: {} })`);
	const popout = await waitFor(
		async () => (await firefox.evaluate(options, ALL)).find((w) => w.type === "popup"),
		"the pop-out",
	);
	for (let i = 1; i <= 4; i++) {
		const bounds = { width: 500 + i * 10, height: 600 + i * 10, left: 200 + i * 5, top: 110 };
		await firefox.evaluate(options, `browser.windows.update(${popout.id}, ${JSON.stringify(bounds)})`);
		await sleep(300);
	}
	// The pop-out's 1.5 s settle, and Firefox's own half-second save delay after it.
	await sleep(4_000);
	await firefox.close(options).catch(() => {});
} catch (error) {
	failed++;
	console.error(error);
} finally {
	await firefox.quit({
		beforeRemove: (profile) => {
			const store = JSON.parse(readFileSync(path.join(profile, "xulstore.json"), "utf8"));
			saved = store["chrome://browser/content/browser.xhtml"]?.["main-window"];
		},
	});
	await server.close();
}
const expected = main && {
	screenX: String(main.left),
	screenY: String(main.top),
	width: String(main.width),
	height: String(main.height),
};
const ok =
	!!saved && !!expected && Object.entries(expected).every(([key, value]) => saved[key] === value);
if (!ok) failed++;
console.log(`${ok ? "pass" : "FAIL"}  Firefox saves the browser window's bounds, not the pop-out's`);
if (!ok) console.log(`  saved ${JSON.stringify(saved)}, browser window ${JSON.stringify(expected)}`);
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
