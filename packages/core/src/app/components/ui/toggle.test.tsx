/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Toggle } from "./toggle";

afterEach(cleanup);

describe("Toggle", () => {
	it("is named by its label and reports its state", () => {
		const onChange = vi.fn();
		render(<Toggle checked={false} onChange={onChange} label="Enable autofill" />);
		const toggle = screen.getByRole("button", { name: "Enable autofill" });
		expect(toggle.getAttribute("aria-pressed")).toBe("false");
		fireEvent.click(toggle);
		expect(onChange).toHaveBeenCalledWith(true);
	});

	it("centres its knob vertically whatever the state (#234)", () => {
		const { container, rerender } = render(
			<Toggle checked={false} onChange={() => {}} label="x" />,
		);
		const knob = () => container.querySelector("span")?.className ?? "";
		expect(knob()).toContain("top-1/2");
		rerender(<Toggle checked onChange={() => {}} label="x" />);
		expect(knob()).toContain("-translate-y-1/2");
	});
});
