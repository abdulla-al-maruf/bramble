import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";
import { createVault, openPopup, optionsUrl } from "./helpers";

// Shift-click in the list's selection mode (#220). Run in a real browser because a click on the
// checkbox reaches the row through its label, which forwards the click to the input, and the
// row reads Shift off that click.

const dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(
	dir,
	"../../clients/extension/src/fixtures/imports/bitwarden-passkeys.json",
);

test("shift-click selects or clears every row between two clicks", async ({
	context,
	extensionId,
}) => {
	const setup = await context.newPage();
	await createVault(setup, extensionId);
	await setup.goto(`${optionsUrl(extensionId)}?screen=import`);
	const card = setup
		.locator("label")
		.filter({ hasText: /Bitwarden/ })
		.first();
	await card.locator('input[type="file"]').setInputFiles(FIXTURE);
	await setup.getByRole("button", { name: /Import 7 items/i }).click();
	await expect(setup.getByRole("heading", { name: /Imported 7 items/i })).toBeVisible();

	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await popup.getByRole("button", { name: "Select items" }).click();
	const boxes = popup.locator('label:has(input[type="checkbox"])');
	const ticked = async () => {
		const out: number[] = [];
		for (let i = 0; i < 7; i++) if (await boxes.nth(i).locator("input").isChecked()) out.push(i);
		return out;
	};

	await boxes.nth(1).click();
	await boxes.nth(4).click({ modifiers: ["Shift"] });
	await expect(popup.getByText("4 selected")).toBeVisible();
	expect(await ticked()).toEqual([1, 2, 3, 4]);

	// From the last row clicked (4) back to an already ticked one clears the range.
	await boxes.nth(2).click({ modifiers: ["Shift"] });
	await expect(popup.getByText("1 selected")).toBeVisible();
	expect(await ticked()).toEqual([1]);

	// The row itself, not only its checkbox.
	await popup
		.locator("[data-row-open]")
		.nth(6)
		.click({ modifiers: ["Shift"] });
	await expect(popup.getByText("6 selected")).toBeVisible();
	expect(await ticked()).toEqual([1, 2, 3, 4, 5, 6]);
});
