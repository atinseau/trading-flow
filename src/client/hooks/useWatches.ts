import { api } from "@client/lib/api";
import type { WatchConfig } from "@domain/schemas/WatchesConfig";
import { useQuery } from "@tanstack/react-query";

export type WatchListItem = {
  id: string;
  enabled: boolean;
  version: number;
  config: WatchConfig;
  createdAt: string;
  updatedAt: string;
};

export function useWatches() {
  return useQuery({
    queryKey: ["watches"],
    queryFn: () => api<WatchListItem[]>("/api/watches"),
    staleTime: 30_000,
  });
}
