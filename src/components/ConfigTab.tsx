import { AtlasSwitch } from "@/components/atlas/AtlasSwitch";
import { AtlasHeading } from "@/components/atlas/AtlasHeading";
import { SettingsIndex } from "@/components/atlas/SettingsIndex";
import { useState } from "react";
import { Bell, FileJson, FolderOpen, Server, Settings2 } from "lucide-react";
import { Button } from "@/components/Button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/Card";
import { ConfigBuilder } from "@/components/ConfigBuilder";
import { SubscriptionIdentityCard } from "@/components/SubscriptionIdentityCard";
import { ProxiesCard } from "@/components/ProxiesCard";
import { UpdateCard } from "@/components/UpdateCard";
import { AccentThemePicker } from "@/components/AccentThemePicker";
import { LanguagePicker } from "@/components/LanguagePicker";
import { basename } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import {
  areNotificationsEnabled,
  requestNotificationPermission,
  setNotificationsEnabled,
} from "@/lib/notifications";
import type {
  BinaryInfo,
  GeneratorSettings,
  Outbound,
  SingboxVersion,
  StatusReport,
} from "@/lib/types";

const inTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const desktopSettingsSections=[["atlas-config-files","nav.config"],["atlas-config-appearance","settings.appearance"],["atlas-config-network","settings.network"],["atlas-config-about","settings.about"]] as const;

export interface ConfigTabProps {
  configPath: string;
  binary: BinaryInfo | null;
  version: SingboxVersion | null;
  xrayVersion: string | null;
  status: StatusReport;
  profiles: Outbound[];
  settings: GeneratorSettings;
  onSettingsChange: (next: GeneratorSettings) => void;
  onResetSettings: () => void;
  onPickConfig: () => void;
  onUseDefault: () => void;
  onConfigPath: (path: string | null) => void;
  currentSingboxVersion?: string | null;
  onSingboxUpdated?: () => void;
}

export function ConfigTab({
  configPath,
  binary,
  version,
  xrayVersion,
  status,
  profiles,
  settings,
  onSettingsChange,
  onResetSettings,
  onPickConfig,
  onUseDefault,
  onConfigPath,
  currentSingboxVersion,
  onSingboxUpdated,
}: ConfigTabProps) {
  const { t } = useI18n();
  const [notificationsEnabled, setNotificationsEnabledState] = useState<boolean>(() =>
    areNotificationsEnabled(),
  );

  const handleToggleNotifications = async (val: boolean) => {
    setNotificationsEnabled(val);
    setNotificationsEnabledState(val);
    if (val) {
      await requestNotificationPermission();
    }
  };

  return (
    <div className="atlas-page atlas-settings">
      <AtlasHeading icon={Settings2} title={t("settings.title")}/>
      <SettingsIndex sections={desktopSettingsSections}/>
      <section className="atlas-group" id="atlas-config-files" tabIndex={-1} aria-label={t("nav.config")}>
      {/* Config picker */}
      <Card className="atlas-section">
        <CardHeader>
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              <FileJson className="h-4 w-4 text-theme-accent" />
              {t("config.activeConfigTitle")}
            </CardTitle>
            <CardDescription>
              {t("config.activeConfigDesc")}{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                sing-box run -c &lt;path&gt;
              </code>
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="flex-1 justify-start truncate"
              onClick={onPickConfig}
            >
              <FolderOpen className="h-3.5 w-3.5 mr-1.5" />
              <span className="truncate">
                {configPath ? basename(configPath) : t("config.pickConfigFile")}
              </span>
            </Button>
            <Button variant="outline" size="sm" onClick={onUseDefault}>
              {t("config.useDefault")}
            </Button>
          </div>
          {configPath && (
            <p className="break-all font-mono text-[11px] text-muted-foreground">
              {configPath}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Config builder */}
      <ConfigBuilder
        profiles={profiles}
        settings={settings}
        onSettingsChange={onSettingsChange}
        onResetSettings={onResetSettings}
        onConfigPath={onConfigPath}
      />

      </section>
      <section className="atlas-group" id="atlas-config-appearance" tabIndex={-1} aria-label={t("settings.appearance")}>
        <h3 className="atlas-group-title">{t("settings.appearance")}</h3>
        <div className="atlas-preferences"><LanguagePicker/><AccentThemePicker/></div>
      </section>
      <section className="atlas-group" id="atlas-config-network" tabIndex={-1} aria-label={t("settings.network")}>

      {/* Native Desktop Notifications */}
      <Card className="atlas-section">
        <CardContent className="pt-6">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Bell className="h-4 w-4 text-theme-accent" />
                <span className="text-xs font-medium text-foreground">
                  {t("notify.notificationsTitle")}
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {t("notify.notificationsDesc")}
              </p>
            </div>
            <AtlasSwitch label={t("notify.notificationsTitle")} checked={notificationsEnabled}
              onChange={enabled=>void handleToggleNotifications(enabled)} />
          </div>
        </CardContent>
      </Card>

      {/* Live: proxies */}
      <ProxiesCard status={status} />

      </section>
      <section className="atlas-group" id="atlas-config-about" tabIndex={-1} aria-label={t("settings.about")}>
      {/* Binary info */}
      <Card className="atlas-section">
        <CardHeader>
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              <Server className="h-4 w-4 text-theme-accent" />
              {t("config.coreBinariesTitle")}
            </CardTitle>
            <CardDescription>{t("config.coreBinariesDesc")}</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-xs">
          <Row label={t("config.tablePath")} value={binary?.path || "—"} mono />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Row label={t("config.tableSize")} value={binary ? formatBytes(binary.size_bytes) : "—"} mono />
            <Row label={t("config.tableExists")} value={binary?.exists ? t("common.yes") : t("common.no")} mono />
            <Row label="sing-box" value={version?.version || "—"} mono />
            <Row label="Xray" value={xrayVersion || "—"} mono />
          </div>
          {version && (
            <div className="mt-2 space-y-1.5 border-t border-border/80 pt-3">
              <Row label={t("config.tableRevision")} value={version.revision.slice(0, 16)} mono />
              <Row label={t("config.tableEnv")} value={version.environment} mono />
            </div>
          )}
        </CardContent>
      </Card>

      <SubscriptionIdentityCard />

      {/* App shell + sing-box auto-update */}
      <UpdateCard
        currentSingboxVersion={currentSingboxVersion ?? null}
        onSingboxUpdated={onSingboxUpdated ?? (() => {})}
      />
      </section>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-[10px] text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "truncate",
          mono && "font-mono text-[11px]",
          !value || value === "—" ? "text-muted-foreground" : "text-foreground",
        )}
        title={value}
      >
        {value}
      </p>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
