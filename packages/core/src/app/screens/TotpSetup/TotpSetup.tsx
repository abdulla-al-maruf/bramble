import { Trans, useLingui } from "@lingui/react/macro";
import { AlertTriangle, KeyRound, type LucideIcon, Search, ShieldCheck } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { ParsedTotp, QrScanFailure } from "../../../util/totp";
import { TotpCode } from "../../components/TotpCode";
import { Button } from "../../components/ui/button";
import { InlineConfirm } from "../../components/ui/inline-confirm";
import { Segmented, SegmentedTab } from "../../components/ui/segmented";
import { TextField } from "../../components/ui/text-field";

/** One login the handed-over key could be saved to. */
export interface TotpTarget {
	id: string;
	name: string;
	secondary: string;
	icon: LucideIcon;
	initials?: string;
	/** This login already holds an authenticator key, so saving here replaces a working one. */
	hasTotp: boolean;
}

interface TotpSetupProps {
	/** Issuer and account parsed out of the key; both are blank for a bare setup key. */
	issuer: string;
	account: string;
	totp: ParsedTotp["totp"];
	copied: boolean;
	onCopy: (code: string) => void;
	/** Logins that look like this key's site, shown before any search. */
	suggested: TotpTarget[];
	/** Logins matching `query`; empty while there is no query. */
	results: TotpTarget[];
	query: string;
	onQueryChange: (q: string) => void;
	onAdd: (id: string) => Promise<void>;
	onCreateNew: (name: string, username: string) => Promise<void>;
}

/**
 * Saves an authenticator key another app or a website handed over (Set Up Codes In on iOS and
 * macOS, an Android `otpauth://` intent). Nothing is written until the user taps a save on this
 * screen, which names the login it goes to: an entry point any app can fire must not write to
 * the vault by itself. See docs/totp-uri-handler.md.
 */
export function TotpSetup({
	issuer,
	account,
	totp,
	copied,
	onCopy,
	suggested,
	results,
	query,
	onQueryChange,
	onAdd,
	onCreateNew,
}: TotpSetupProps) {
	const { t } = useLingui();
	// Opens where the likely answer is: an existing login if one matches, a new one otherwise.
	const [tab, setTab] = useState<"existing" | "new">(suggested.length > 0 ? "existing" : "new");
	const [name, setName] = useState(issuer || account || t`2FA code`);
	const [username, setUsername] = useState(account);
	// "new" or the id being saved to; one save at a time.
	const [busy, setBusy] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	const about = [issuer, account].filter(Boolean).join(" · ");
	const searching = query.trim() !== "";

	const run = async (key: string, save: () => Promise<void>) => {
		setBusy(key);
		setFailed(false);
		try {
			await save();
		} catch {
			setFailed(true);
			setBusy(null);
		}
	};
	const add = (id: string) => run(id, () => onAdd(id));

	return (
		<main className="flex-1 min-h-0 flex flex-col w-full max-w-5xl mx-auto px-4 py-5">
			<div className="mb-4 flex items-start gap-3">
				<div className="shrink-0 w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
					<ShieldCheck className="w-5 h-5 text-primary" />
				</div>
				<div className="min-w-0">
					<h2 className="text-base">
						<Trans>Add 2FA code</Trans>
					</h2>
					{about && <p className="text-sm text-muted-foreground truncate">{about}</p>}
				</div>
			</div>

			<section className="mb-4 rounded-lg border border-border/50 bg-card/50 px-4 py-3 space-y-1">
				<p className="text-xs text-muted-foreground">
					<Trans>Current code</Trans>
				</p>
				<TotpCode totp={totp} copied={copied} onCopy={onCopy} />
				<p className="text-xs text-muted-foreground">
					<Trans>If the site asks for a code to finish setting up, enter this one.</Trans>
				</p>
			</section>

			<Segmented className="mb-4">
				<SegmentedTab
					active={tab === "existing"}
					disabled={busy !== null}
					onClick={() => setTab("existing")}
				>
					<Trans>Existing login</Trans>
				</SegmentedTab>
				<SegmentedTab active={tab === "new"} disabled={busy !== null} onClick={() => setTab("new")}>
					<Trans>New login</Trans>
				</SegmentedTab>
			</Segmented>

			{tab === "existing" ? (
				<>
					<TextField
						label={t`Search your logins`}
						type="search"
						value={query}
						onChange={(e) => onQueryChange(e.target.value)}
						startAdornment={<Search className="w-4 h-4" />}
						className="mb-3"
					/>
					<div className="flex-1 min-h-0 overflow-y-auto">
						{searching ? (
							results.length > 0 ? (
								<TargetList targets={results} busy={busy} onAdd={add} />
							) : (
								<Hint>
									<Trans>No logins match.</Trans>
								</Hint>
							)
						) : suggested.length > 0 ? (
							<>
								<p className="mb-2 px-1 text-xs font-medium text-muted-foreground">
									<Trans>Suggested</Trans>
								</p>
								<TargetList targets={suggested} busy={busy} onAdd={add} />
							</>
						) : (
							<Hint>
								<Trans>Search for the login to add the code to.</Trans>
							</Hint>
						)}
					</div>
				</>
			) : (
				<form
					className="space-y-3"
					onSubmit={(e) => {
						e.preventDefault();
						void run("new", () => onCreateNew(name.trim(), username.trim()));
					}}
				>
					<TextField label={t`Name`} value={name} onChange={(e) => setName(e.target.value)} />
					<TextField
						label={t`Username`}
						value={username}
						onChange={(e) => setUsername(e.target.value)}
					/>
					<Button
						type="submit"
						variant="primary"
						fullWidth
						disabled={busy !== null || !name.trim()}
					>
						{busy === "new" ? <Trans>Saving…</Trans> : <Trans>Save new login</Trans>}
					</Button>
				</form>
			)}

			{failed && (
				<p role="alert" className="mt-3 px-1 text-sm text-destructive">
					<Trans>Couldn't save the 2FA code. Try again.</Trans>
				</p>
			)}
		</main>
	);
}

function Hint({ children }: { children: ReactNode }) {
	return <p className="py-8 text-center text-sm text-muted-foreground">{children}</p>;
}

function TargetList({
	targets,
	busy,
	onAdd,
}: {
	targets: TotpTarget[];
	busy: string | null;
	onAdd: (id: string) => Promise<void>;
}) {
	const { t } = useLingui();
	return (
		<ul className="space-y-1">
			{targets.map((target) => (
				<li
					key={target.id}
					className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border/50 bg-card/50"
				>
					<span className="shrink-0 w-9 h-9 rounded-lg bg-muted flex items-center justify-center text-xs text-muted-foreground">
						{target.initials ?? <target.icon className="w-4 h-4" />}
					</span>
					<span className="min-w-0 flex-1">
						<span className="block truncate text-sm">{target.name}</span>
						<span className="block truncate text-xs text-muted-foreground">{target.secondary}</span>
					</span>
					{/* Asked here, not after: replacing loses a key that presumably still works. The
					    question shows only where it fits beside the buttons without pushing the name out. */}
					{target.hasTotp ? (
						<InlineConfirm
							className="shrink-0"
							variant="destructiveOutline"
							prompt={
								<span className="hidden sm:flex items-center gap-1 text-warning">
									<AlertTriangle className="w-3.5 h-3.5" />
									<Trans>Replace its code?</Trans>
								</span>
							}
							confirmLabel={<Trans>Replace</Trans>}
							busyLabel={<Trans>Replacing…</Trans>}
							onConfirm={() => onAdd(target.id)}
							trigger={(arm) => (
								<Button
									variant="secondary"
									size="sm"
									disabled={busy !== null}
									onClick={arm}
									aria-label={t`Replace the 2FA code in ${target.name}`}
								>
									<Trans>Replace</Trans>
								</Button>
							)}
						/>
					) : (
						<Button
							variant="secondary"
							size="sm"
							className="shrink-0"
							disabled={busy !== null}
							onClick={() => void onAdd(target.id)}
							aria-label={t`Add the 2FA code to ${target.name}`}
						>
							{busy === target.id ? <Trans>Adding…</Trans> : <Trans>Add</Trans>}
						</Button>
					)}
				</li>
			))}
		</ul>
	);
}

/**
 * Why a handed-over URI can't become an authenticator key. Same four verdicts the QR
 * scanner classifies, but the way out differs: nothing was scanned here, an app sent us
 * something, so the scanner's "make the QR visible and retry" advice would be nonsense.
 */
export function TotpSetupFailure({
	failure,
	vendor,
	onDismiss,
}: {
	failure: QrScanFailure;
	vendor?: string;
	onDismiss: () => void;
}) {
	const { t } = useLingui();

	const explain = () => {
		switch (failure) {
			case "vendor-app":
				return t`That link sets up ${vendor ?? "another authenticator app"}, so it holds no key to save. On the site, choose to use a different authenticator app, then use the code it offers.`;
			case "migration":
				return t`That link is an authenticator export holding several accounts, not a setup code. Add each account from its own site instead.`;
			case "not-totp":
				return t`That link isn't an authenticator setup code Bramble can use. Counter-based (HOTP) codes aren't supported.`;
			default:
				return t`Nothing usable was handed over. Open the site's 2FA page and add the code from the login instead.`;
		}
	};

	return (
		<main className="flex-1 min-h-0 flex flex-col items-center justify-center w-full max-w-md mx-auto px-6 text-center">
			<div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center mb-4">
				<KeyRound className="w-6 h-6 text-destructive" />
			</div>
			<h2 className="text-base mb-2">
				<Trans>Can't save this code</Trans>
			</h2>
			<p className="text-sm text-muted-foreground mb-6">{explain()}</p>
			<Button onClick={onDismiss}>
				<Trans>Back to vault</Trans>
			</Button>
		</main>
	);
}
