import { Check, Moon, Palette } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAccentTheme } from "@/hooks/useAccentTheme";
import type { AccentId } from "@/lib/accentTheme";

interface Props {
  compact?: boolean;
}

export function AccentThemePicker({ compact = false }: Props) {
  const { accent, setAccent, oled, setOled, accents } = useAccentTheme();

  return (
    <div className={cn("space-y-4", compact ? "text-xs" : "")}>
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2 text-sm font-semibold tracking-tight text-foreground">
            <Palette className="h-4 w-4 text-theme-accent" />
            <span>Accent Theme</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Personalize your connection glow and UI highlights
          </p>
        </div>
      </div>

      {/* Swatches */}
      <div className="grid grid-cols-5 gap-2.5">
        {accents.map((item) => {
          const isSelected = accent === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setAccent(item.id as AccentId)}
              title={item.label}
              className={cn(
                "group relative flex flex-col items-center gap-1.5 rounded-lg border p-2.5 transition-all duration-200",
                isSelected
                  ? "border-foreground/30 bg-muted/60 shadow-sm"
                  : "border-border/60 bg-card/40 hover:border-border hover:bg-muted/30",
              )}
            >
              <span
                className="relative flex h-7 w-7 items-center justify-center rounded-full transition-transform duration-200 group-hover:scale-105"
                style={{
                  backgroundColor: item.colorHex,
                  boxShadow: isSelected
                    ? `0 0 14px 2px ${item.colorHex}77`
                    : `0 0 6px 0px ${item.colorHex}33`,
                }}
              >
                {isSelected && (
                  <Check className="h-4 w-4 text-zinc-950 stroke-[3]" />
                )}
              </span>
              <span
                className={cn(
                  "text-[11px] font-medium transition-colors",
                  isSelected ? "text-foreground font-semibold" : "text-muted-foreground",
                )}
              >
                {item.label}
              </span>
            </button>
          );
        })}
      </div>

      {/* OLED Toggle */}
      <div className="flex items-center justify-between rounded-lg border border-border/60 bg-card/40 p-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-muted/60 text-muted-foreground">
            <Moon className="h-4 w-4" />
          </div>
          <div>
            <div className="text-xs font-medium text-foreground">OLED Pure Black</div>
            <div className="text-[11px] text-muted-foreground">
              True pitch-black background for OLED/AMOLED displays
            </div>
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={oled}
          onClick={() => setOled(!oled)}
          className={cn(
            "relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            oled ? "bg-foreground" : "bg-muted",
          )}
        >
          <span
            className={cn(
              "pointer-events-none inline-block h-4 w-4 transform rounded-full bg-background shadow-lg ring-0 transition duration-200 ease-in-out",
              oled ? "translate-x-4" : "translate-x-0",
            )}
          />
        </button>
      </div>
    </div>
  );
}
