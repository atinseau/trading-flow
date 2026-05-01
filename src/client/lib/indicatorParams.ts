import type { ParamDescriptor } from "@domain/services/IndicatorPlugin";

export type ParamValue = number | string;

export function isValidParamValue(d: ParamDescriptor, v: unknown): boolean {
  if (d.kind === "number") {
    return typeof v === "number" && v >= d.min && v <= d.max;
  }
  return typeof v === "string" && (d.options as ReadonlyArray<string>).includes(v);
}

export function defaultParamFromDescriptor(d: ParamDescriptor): ParamValue {
  return d.kind === "number" ? d.min : d.options[0]!;
}
