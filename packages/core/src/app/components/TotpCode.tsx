import { useLingui } from "@lingui/react/macro";
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { type ParsedTotp, totpAt } from "../../util/totp";
import { Button } from "./ui/button";

/** The current code for an authenticator key, recomputed every second, with a countdown ring. */
export function TotpCode({
	totp,
	copied,
	onCopy,
}: {
	totp: ParsedTotp["totp"];
	copied: boolean;
	onCopy: (code: string) => void;
}) {
	const { t } = useLingui();
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, []);

	const { code, secondsRemaining } = totpAt(totp, now);

	return (
		<div className="flex items-center justify-between gap-3">
			<div className="flex items-baseline gap-3 font-mono text-2xl tracking-wider tabular-nums">
				{code.length === 6 ? (
					<>
						<span>{code.slice(0, 3)}</span>
						<span>{code.slice(3)}</span>
					</>
				) : (
					<span>{code}</span>
				)}
			</div>
			<div className="flex items-center gap-3">
				<CountdownRing remaining={secondsRemaining} period={totp.period} />
				<Button
					variant="ghost"
					size="none"
					onClick={() => onCopy(code)}
					className="p-1.5 rounded-md"
					aria-label={t`Copy verification code`}
				>
					{copied ? <Check className="w-4 h-4 text-primary" /> : <Copy className="w-4 h-4" />}
				</Button>
			</div>
		</div>
	);
}

/** Ring + number that drains as the current code ages out, turning red in the final few seconds. */
function CountdownRing({ remaining, period }: { remaining: number; period: number }) {
	const { t } = useLingui();
	const radius = 11;
	const circumference = 2 * Math.PI * radius;
	const fraction = Math.max(0, Math.min(1, remaining / period));
	const low = remaining <= 5;
	return (
		<div
			className="relative flex items-center justify-center w-7 h-7"
			title={t`${remaining}s left`}
		>
			<svg width="28" height="28" viewBox="0 0 28 28" className="-rotate-90" aria-hidden="true">
				<circle cx="14" cy="14" r={radius} fill="none" strokeWidth="2" className="stroke-muted" />
				<circle
					cx="14"
					cy="14"
					r={radius}
					fill="none"
					strokeWidth="2"
					strokeLinecap="round"
					strokeDasharray={circumference}
					strokeDashoffset={circumference * (1 - fraction)}
					className={low ? "stroke-destructive" : "stroke-foreground"}
					style={{ transition: "stroke-dashoffset 1s linear" }}
				/>
			</svg>
			<span
				className={`absolute text-[10px] tabular-nums ${
					low ? "text-destructive" : "text-muted-foreground"
				}`}
			>
				{remaining}
			</span>
		</div>
	);
}
