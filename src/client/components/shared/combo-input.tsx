import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { cn } from "../../lib/utils";
import { Check, ChevronsUpDown } from "lucide-react";
import { useState } from "react";

export type ComboOption = {
  value: string;
  label: string;
  hint?: string;
};

/**
 * Free-text combobox with predefined suggestions.
 * Users can pick a suggestion OR type their own value (kept on confirm).
 *
 * Pattern: Popover-wrapped button trigger + cmdk Command palette inside.
 * Submitting the search input "as-is" via Enter is allowed (sets value to
 * whatever is typed) — that's the "open" part the design calls for.
 */
export function ComboInput(props: {
  value: string;
  onChange: (next: string) => void;
  options: ComboOption[];
  placeholder?: string;
  emptyHint?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const matched = props.options.find((o) => o.value === props.value);

  const commit = (next: string): void => {
    props.onChange(next);
    setOpen(false);
    setSearch("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          className={cn(
            "flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs transition-colors",
            "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-hidden",
            "disabled:cursor-not-allowed disabled:opacity-50",
            !props.value && "text-muted-foreground",
          )}
        >
          <span className="truncate font-mono text-left">
            {matched?.label ?? props.value ?? props.placeholder ?? "Choisir…"}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput
            placeholder={props.placeholder ?? "Rechercher ou saisir une valeur…"}
            value={search}
            onValueChange={setSearch}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                search.trim() &&
                !props.options.some((o) => o.value === search)
              ) {
                e.preventDefault();
                commit(search.trim());
              }
            }}
          />
          <CommandList>
            <CommandEmpty>
              {search.trim() ? (
                <button
                  type="button"
                  onClick={() => commit(search.trim())}
                  className="text-xs text-foreground hover:underline"
                >
                  Utiliser <span className="font-mono font-semibold">"{search.trim()}"</span> tel
                  quel
                </button>
              ) : (
                (props.emptyHint ?? "Aucune correspondance")
              )}
            </CommandEmpty>
            <CommandGroup>
              {props.options.map((opt) => (
                <CommandItem
                  key={opt.value}
                  value={opt.value}
                  onSelect={() => commit(opt.value)}
                  className="flex items-start gap-2"
                >
                  <Check
                    className={cn(
                      "mt-0.5 size-4 shrink-0",
                      props.value === opt.value ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="font-mono text-sm">{opt.label}</span>
                    {opt.hint && <span className="text-xs text-muted-foreground">{opt.hint}</span>}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
