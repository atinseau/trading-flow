import { Button } from "@client/components/ui/button";
import { Card } from "@client/components/ui/card";
import { Checkbox } from "@client/components/ui/checkbox";
import { buildIndicatorsMatrix, PRESETS, type PresetName } from "@client/lib/indicatorsPresets";
import { INDICATOR_METADATA_BY_TAG } from "@shared/indicatorMetadata";
import { useFormContext } from "react-hook-form";

const TAG_LABELS: Record<string, string> = {
  trend: "Trend",
  volatility: "Volatility",
  momentum: "Momentum",
  volume: "Volume",
  structure: "Structure",
  liquidity: "Liquidity",
};
const TAG_ORDER = ["trend", "volatility", "momentum", "volume", "structure", "liquidity"];

function InfoCard() {
  return (
    <Card className="p-4 text-sm space-y-2">
      <div className="font-semibold">Mode d'analyse</div>
      <p className="text-muted-foreground">
        Aucun indicateur coché = <strong>mode naked</strong>: le bot reçoit le chart brut (bougies
        seules) et fait une analyse purement visuelle. Plus créatif, moins guidé. Cocher un
        indicateur l'ajoute à la fois sur le chart et dans le prompt.
      </p>
      <p className="text-muted-foreground">
        Plus d'indicateurs = plus de tokens dans chaque appel LLM (~ +5% de coût par indicateur).
        Le score de confiance final s'adapte aux indicateurs activés.
      </p>
    </Card>
  );
}

function PresetButtons({ onApply }: { onApply: (preset: PresetName) => void }) {
  return (
    <div className="flex gap-2">
      <Button type="button" variant="outline" size="sm" onClick={() => onApply("naked")}>
        Naked
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={() => onApply("recommended")}>
        Recommended
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={() => onApply("all")}>
        Tout cocher
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => onApply("naked")}>
        Tout décocher
      </Button>
    </div>
  );
}

export function SectionIndicators() {
  const form = useFormContext();
  const matrix = (form.watch("indicators") ?? {}) as Record<string, { enabled: boolean }>;

  const apply = (preset: PresetName) => {
    form.setValue("indicators", buildIndicatorsMatrix(PRESETS[preset]), { shouldDirty: true });
  };

  return (
    <div className="space-y-6">
      <InfoCard />
      <PresetButtons onApply={apply} />
      <div className="space-y-6">
        {TAG_ORDER.map((tag) => {
          const items = INDICATOR_METADATA_BY_TAG[tag] ?? [];
          if (items.length === 0) return null;
          return (
            <div key={tag} className="space-y-3">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                {TAG_LABELS[tag] ?? tag}
              </div>
              <div className="space-y-2 pl-1">
                {items.map((m) => {
                  const checked = matrix[m.id]?.enabled === true;
                  return (
                    <label key={m.id} className="flex items-start gap-3 cursor-pointer">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) => {
                          form.setValue(
                            `indicators.${m.id}` as "indicators",
                            { enabled: v === true } as never,
                            { shouldDirty: true },
                          );
                        }}
                      />
                      <div className="space-y-0.5">
                        <div className="font-medium">{m.displayName}</div>
                        <div className="text-xs text-muted-foreground">{m.shortDescription}</div>
                        <div className="text-[11px] text-muted-foreground/80">
                          {m.longDescription}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
