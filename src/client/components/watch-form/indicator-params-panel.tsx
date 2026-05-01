import { useFormContext } from "react-hook-form";
import { Input } from "@client/components/ui/input";
import { Label } from "@client/components/ui/label";
import type { IndicatorClientMetadata } from "@domain/services/IndicatorPlugin";

export function IndicatorParamsPanel({ meta }: { meta: IndicatorClientMetadata }) {
  const form = useFormContext();
  const descriptors = meta.paramsDescriptor ?? [];
  if (descriptors.length === 0) return null;

  const fieldBase = `indicators.${meta.id}.params`;

  return (
    <div className="ml-7 mt-2 space-y-2 rounded-md bg-muted/40 p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Paramètres</div>
      {descriptors.map((d) => {
        const fieldName = `${fieldBase}.${d.key}`;
        const defaultVal = (meta.defaultParams as Record<string, unknown> | undefined)?.[d.key];
        if (d.kind === "number") {
          return (
            <div key={d.key} className="flex items-center gap-3 text-xs">
              <Label className="w-24 shrink-0">{d.label}</Label>
              <Input
                type="number"
                min={d.min}
                max={d.max}
                step={d.step ?? 1}
                defaultValue={defaultVal as number | undefined}
                {...form.register(fieldName, { valueAsNumber: true })}
                className="h-8 w-24"
              />
              {d.help && <span className="text-muted-foreground">{d.help}</span>}
            </div>
          );
        }
        return (
          <div key={d.key} className="flex items-center gap-3 text-xs">
            <Label className="w-24 shrink-0">{d.label}</Label>
            <select
              defaultValue={defaultVal as string | undefined}
              {...form.register(fieldName)}
              className="h-8 rounded-md border bg-background px-2"
            >
              {d.options.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
            {d.help && <span className="text-muted-foreground">{d.help}</span>}
          </div>
        );
      })}
    </div>
  );
}
