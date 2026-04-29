import { api } from "@client/lib/api";
import { useQuery } from "@tanstack/react-query";

export type WatchListItem = {
  id: string;
  enabled: boolean;
  version: number;
  config: {
    id: string;
    asset: { symbol: string };
    timeframes: { primary: string };
  };
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
