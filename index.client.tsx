import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SupervisionSettingsScreen } from "./client/supervision-settings.js";
import { isSelectableSupervisor, onRoutingChanged, persistAndSync, synchronizePersistedSettings } from "./client/controller.js";

export default function contribute(client: PluginClientContext): () => void {
  let disposed = false;
  let header: ReturnType<PluginClientContext["addHeaderButton"]> | null = null;
  const disable = async () => {
    await persistAndSync(client, {
      enabled: false, supervisorAgentId: null, supervisorTitle: null, workspaceId: null,
    });
    header?.remove();
    header = null;
  };
  const showHeader = (workspaceId: string) => {
    if (disposed) return;
    header?.remove();
    header = client.addHeaderButton({
      id: "supervision-recipient",
      workspaceId,
      button: {
        title: "Supervisor notifications",
        icon: "Bell",
        behavior: {
          kind: "menu",
          items: [
            {
              kind: "item", id: "settings", title: "Open supervision settings", icon: "Settings",
              behavior: { kind: "action", onPress() { client.openSettings("supervisor-routing"); } },
            },
            { kind: "separator", id: "separator" },
            {
              kind: "item", id: "disable", title: "Disable notifications", icon: "BellOff",
              behavior: { kind: "action", onPress: disable },
            },
          ],
        },
      },
    });
  };
  const offRouting = onRoutingChanged((values) => {
    if (values.enabled && values.workspaceId !== null) showHeader(values.workspaceId);
    else {
      header?.remove();
      header = null;
    }
  });
  const offSettings = client.addSettingsScreen({
    id: "supervisor-routing",
    title: "Supervision",
    icon: "Bell",
    Component: SupervisionSettingsScreen,
  });
  const offSet = client.addCommandCenterItem({
    id: "set-supervision-recipient",
    title: "Set this thread as Supervisor",
    icon: "Bell",
    keywords: ["supervision", "notifications", "recipient"],
    context: "agent",
    async onSelect({ agent, workspace, rpc }) {
      if (!isSelectableSupervisor(agent)) {
        throw new Error("Only an active codex-supervisor thread can receive supervision notifications");
      }
      await persistAndSync({ rpc }, {
        enabled: true,
        supervisorAgentId: agent.id,
        supervisorTitle: agent.title?.trim() || "Supervisor",
        workspaceId: workspace.id,
      });
    },
  });
  const offOpen = client.addCommandCenterItem({
    id: "open-supervision-settings",
    title: "Open supervision settings",
    icon: "Settings",
    keywords: ["supervisor", "unset", "notifications"],
    context: "global",
    onSelect({ openSettings }) { openSettings("supervisor-routing"); },
  });
  const offDisable = client.addCommandCenterItem({
    id: "disable-supervision-notifications",
    title: "Disable Supervisor notifications",
    icon: "BellOff",
    keywords: ["supervision", "unset", "recipient"],
    context: "global",
    onSelect: disable,
  });

  // Paseo 0.8 does not expose settings to the server contribution. A loaded
  // client is therefore the explicit bootstrap bridge after daemon restart.
  void synchronizePersistedSettings(client).then((restored) => {
    if (restored?.status === "active" && restored.values.workspaceId !== null) {
      showHeader(restored.values.workspaceId);
    }
  }).catch(() => undefined);
  return () => {
    disposed = true;
    header?.remove();
    offRouting(); offSettings(); offSet(); offOpen(); offDisable();
  };
}
