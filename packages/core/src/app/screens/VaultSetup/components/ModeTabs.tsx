import { Trans } from "@lingui/react/macro";
import { Segmented, SegmentedTab as Tab } from "../../../components/ui/segmented";
import type { VaultSetupMode } from "../types";

interface ModeTabsProps {
	mode: VaultSetupMode;
	onChange: (mode: VaultSetupMode) => void;
	disabled?: boolean;
	/** Show the "Restore from backup" tab; its panel is the .bramble restore flow rendered inline
	 * (not a page swap), so the tabs stay put. Same experience in first-run and adding views. */
	showRestore?: boolean;
	/** Show the "Join a device" tab. */
	showJoin?: boolean;
}

export function ModeTabs({ mode, onChange, disabled, showRestore, showJoin }: ModeTabsProps) {
	return (
		<Segmented className="mb-4">
			<Tab active={mode === "create"} disabled={disabled} onClick={() => onChange("create")}>
				<Trans>Create new vault</Trans>
			</Tab>
			{showRestore && (
				<Tab active={mode === "restore"} disabled={disabled} onClick={() => onChange("restore")}>
					<Trans>Restore from backup</Trans>
				</Tab>
			)}
			{showJoin && (
				<Tab active={mode === "join"} disabled={disabled} onClick={() => onChange("join")}>
					<Trans>Join a device</Trans>
				</Tab>
			)}
		</Segmented>
	);
}
