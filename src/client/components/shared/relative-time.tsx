import { fmtRelative } from "@client/lib/format";
import { useEffect, useState } from "react";

export function RelativeTime({ date }: { date: string | Date | null | undefined }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  return <span>{fmtRelative(date)}</span>;
}
