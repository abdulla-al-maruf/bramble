import { cn } from "./utils";

interface ToggleProps {
	checked: boolean;
	onChange: (next: boolean) => void;
	label: string;
	disabled?: boolean;
}

/** Switch-style toggle button. The knob keeps an even 2px gap to the track on every side. */
export function Toggle({ checked, onChange, label, disabled = false }: ToggleProps) {
	return (
		<button
			type="button"
			onClick={() => onChange(!checked)}
			disabled={disabled}
			aria-label={label}
			aria-pressed={checked}
			className={cn(
				"relative shrink-0 w-11 h-6 rounded-full border transition-all disabled:opacity-40 disabled:cursor-not-allowed",
				checked ? "bg-primary border-primary/20" : "bg-muted border-input-border",
			)}
		>
			<span
				className={cn(
					"absolute top-1/2 -translate-y-1/2 size-4.5 rounded-full bg-card shadow-sm transition-all",
					checked ? "left-5.5 dark:bg-primary-foreground" : "left-0.5 dark:bg-card-foreground",
				)}
			/>
		</button>
	);
}
