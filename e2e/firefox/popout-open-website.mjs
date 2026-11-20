#!/usr/bin/env node
// Firefox's windows.getLastFocused ignores windowTypes, so with the pop-out in front it named the
// pop-out, and Open website put the site in a tab inside it. Opens the pop-out from one window,
// moves to a second, back to the pop-out, then opens a website: it belongs in the second window.
// Run it HEADED=1: a headless Firefox reports no focus changes.
//
// Manual, not CI: it wants a stock Firefox (see driver.mjs). Build first:
//
//   pnpm --filter @vault/platform-extension build:firefox
//   HEADED=1 FIREFOX_BINARY=/path/to/firefox node e2e/firefox/popout-open-website.mjs

import { launch, OPENER_PAGE, serve, sleep, waitFor } from "./driver.mjs";

const ALL = `browser.windows.getAll({ populate: true }).then((ws) => ws.map((w) => ({ id: w.id, type: w.type, urls: w.tabs.map((t) => t.url) })))`;

const server = await serve({ "*": { body: OPENER_PAGE } });
const firefox = await launch();
let failed = 0;
try {
	const [tab] = (await firefox.contexts()).map((c) => c.context);
	const options = await firefox.openExtensionPage(tab, `http://localhost:${server.port}/`, "options.html");
	const run = (expression) => firefox.evaluate(options, expression);
	await run(`browser.runtime.sendMessage({ type: "POPOUT_OPEN", payload: {} })`);
	const popout = await waitFor(async () => (await run(ALL)).find((w) => w.type === "popup"), "the pop-out");
	await sleep(1_000);
	const second = await run(
		`browser.windows.create({ url: "http://127.0.0.1:${server.port}/second" }).then((w) => w.id)`,
	);
	await sleep(1_000);
	await run(`browser.windows.update(${popout.id}, { focused: true })`);
	await sleep(1_000);
	const site = `http://127.0.0.1:${server.port}/site`;
	await run(
		`browser.runtime.sendMessage({ type: "AUTOFILL_LAUNCH", payload: { entryId: "any", url: ${JSON.stringify(site)} } })`,
	);
	const landed = await waitFor(
		async () => (await run(ALL)).find((w) => w.urls.includes(site)),
		"the new tab",
	);
	const ok = landed.id === second;
	if (!ok) failed++;
	console.log(`${ok ? "pass" : "FAIL"}  Open website from the pop-out uses the window the user was last in`);
	if (!ok) console.log(`  opened in ${landed.type} window ${landed.id}, expected ${second}`);
} catch (error) {
	failed++;
	console.error(error);
} finally {
	await firefox.quit();
	await server.close();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
