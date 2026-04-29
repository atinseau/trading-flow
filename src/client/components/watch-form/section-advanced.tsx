import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from "@client/components/ui/accordion";
import {
  FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage,
} from "@client/components/ui/form";
import { Input } from "@client/components/ui/input";
import { Switch } from "@client/components/ui/switch";
import { useFormContext } from "react-hook-form";

export function SectionAdvanced() {
  const f = useFormContext();
  return (
    <Accordion type="single" collapsible>
      <AccordionItem value="advanced">
        <AccordionTrigger>Réglages avancés</AccordionTrigger>
        <AccordionContent className="space-y-4 pt-2">

          <FormField control={f.control} name="pre_filter.enabled" render={({ field }) => (
            <FormItem className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <FormLabel>Pré-filtre statistique</FormLabel>
                <FormDescription>
                  Skip les ticks où ATR / volume / RSI ne montrent rien d'intéressant.
                </FormDescription>
              </div>
              <FormControl>
                <Switch checked={field.value} onCheckedChange={field.onChange} />
              </FormControl>
            </FormItem>
          )} />

          <FormField control={f.control} name="setup_lifecycle.score_initial" render={({ field }) => (
            <FormItem>
              <FormLabel>Score initial à la création</FormLabel>
              <FormControl>
                <Input
                  type="number" min={0} max={100}
                  {...field}
                  onChange={(e) => field.onChange(Number(e.target.value))}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )} />

          <FormField control={f.control} name="setup_lifecycle.score_threshold_dead" render={({ field }) => (
            <FormItem>
              <FormLabel>Seuil de mort prématurée</FormLabel>
              <FormControl>
                <Input
                  type="number" min={0} max={100}
                  {...field}
                  onChange={(e) => field.onChange(Number(e.target.value))}
                />
              </FormControl>
              <FormDescription>Au-dessous, le setup est considéré perdu.</FormDescription>
              <FormMessage />
            </FormItem>
          )} />

          <FormField
            control={f.control}
            name="optimization.reviewer_skip_when_detector_corroborated"
            render={({ field }) => (
              <FormItem className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <FormLabel>Skip Reviewer si Detector corrobore</FormLabel>
                  <FormDescription>
                    Économise un appel LLM quand le Detector renforce de lui-même.
                  </FormDescription>
                </div>
                <FormControl>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </FormControl>
              </FormItem>
            )}
          />

        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
