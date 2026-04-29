import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@client/components/ui/form";
import { Input } from "@client/components/ui/input";
import { useFormContext } from "react-hook-form";

export function SectionBudget() {
  const f = useFormContext();
  return (
    <section className="space-y-4">
      <h3 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">
        Budget LLM
      </h3>
      <FormField
        control={f.control}
        name="budget.max_cost_usd_per_day"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Budget max par jour (USD)</FormLabel>
            <FormControl>
              <Input
                type="number"
                step="0.01"
                {...field}
                value={field.value ?? ""}
                onChange={(e) =>
                  field.onChange(e.target.value ? Number(e.target.value) : undefined)
                }
              />
            </FormControl>
            <FormDescription>Au-dessus, la watch se met en pause automatiquement.</FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </section>
  );
}
