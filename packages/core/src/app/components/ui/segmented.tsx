import type { ReactNode } from "react";
import { Button } from "./button";
import { cn } from "./utils";

/** A segmented control: a subtle track with the active choice raised as a card. */
export function Segmented({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div className={cn("flex gap-2 p-1 rounded-lg bg-muted/40 border border-border/50", className)}>
			{children}
		</div>
	);
}

/**
 * One choice in a `Segmented`. leading-tight + text-center keep a two-line label (e.g. "Create
 * new vault" on a narrow phone) neatly stacked rather than a lopsided pill.
 *
 * Every tab reserves the active tab's border, transparent when inactive. Without that the raised
 * tab is ~1.5px wider than its siblings and shifts their sub-pixel offsets, so a label sitting
 * within a pixel of fitting rewrapped depending on which tab was selected ("Restore from backup"
 * went to three lines, issue #84). px-2 rather than px-3 buys the labels 8px of headroom so the
 * wrap is not decided at the boundary in the first place.
 */
export function SegmentedTab({
	active,
	disabled,
	onClick,
	children,
}: {
	active: boolean;
	disabled?: boolean;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<Button
			variant="link"
			size="none"
			onClick={onClick}
			disabled={disabled}
			aria-pressed={active}
			className={cn(
				"flex-1 px-2 py-2 text-sm leading-tight text-center rounded-md border transition-all disabled:opacity-50",
				active
					? "bg-card text-foreground shadow-sm border-border/50"
					: "border-transparent text-muted-foreground hover:text-foreground",
			)}
		>
			{children}
		</Button>
	);
}
