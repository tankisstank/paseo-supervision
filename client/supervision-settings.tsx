import { useMemo, useState } from "react";
import { Text } from "react-native";
import { useSettings, useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { supervisionSettings, syncSupervisorRpc, type SupervisionSettings } from "../shared/supervision.js";
import { notifyRoutingChanged } from "./controller.js";

export function SupervisionSettingsScreen({ theme }: PluginSurfaceProps) {
  const state = useSettings(supervisionSettings);
  const sync = useRpc(syncSupervisorRpc);
  const [syncError, setSyncError] = useState<string | null>(null);
  const textStyle = useMemo(() => ({ color: theme.colors.foregroundMuted }), [theme]);

  if (state.status === "loading") return <Text style={textStyle}>Loading supervision settings…</Text>;
  if (state.status === "error" || state.status === "invalid") {
    return <Text style={textStyle}>Unable to load supervision settings: {state.error}</Text>;
  }

  const save = async (values: SupervisionSettings) => {
    setSyncError(null);
    const prepared = await sync({ intent: "prepare" });
    if (prepared.token === null) {
      setSyncError("Unable to prepare Supervisor routing update.");
      return;
    }
    if (await state.save(values, state.revision)) {
      const result = await sync({ ...values, intent: "commit", token: prepared.token });
      const expected = values.enabled ? "active" : "disabled";
      if (result.status === expected) notifyRoutingChanged(values);
      else {
        notifyRoutingChanged({ ...values, enabled: false });
        setSyncError("Routing changed concurrently. Notifications are off; retry this action.");
      }
    } else {
      notifyRoutingChanged({ ...values, enabled: false });
    }
  };
  const selected = state.values.supervisorAgentId !== null;
  const label = state.values.supervisorTitle ?? state.values.supervisorAgentId ?? "No thread selected";

  return (
    <SettingsSection
      title="Supervisor notifications"
      info="Choose a codex-supervisor thread from the Command Center. After a daemon restart, routing resumes when any Paseo client loads this plugin."
    >
      <SettingsCard>
        <SettingsRow
          label="Selected thread"
          {...(state.values.supervisorAgentId === null ? {} : { hint: state.values.supervisorAgentId })}
          error={syncError ?? state.saveError}
        >
          <Text style={textStyle}>{label}</Text>
        </SettingsRow>
        <SettingsSwitch
          label="Receive drift notifications"
          hint={selected ? "Routes new alerts to the selected thread." : "Select a Supervisor thread first."}
          value={state.values.enabled && selected}
          disabled={!selected || state.saving}
          onValueChange={(enabled) => { void save({ ...state.values, enabled }); }}
        />
        <SettingsAction
          label="Supervisor thread"
          hint="This clears the recipient and stops notification delivery."
          actionLabel="Unset"
          disabled={!selected || state.saving}
          onPress={() => { void save({ enabled: false, supervisorAgentId: null, supervisorTitle: null, workspaceId: null }); }}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
