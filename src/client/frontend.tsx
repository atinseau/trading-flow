import { Button } from "@client/components/ui/button";
import { createRoot } from "react-dom/client";

const container = document.getElementById("root") ?? document.body;
createRoot(container).render(
  <div className="p-8">
    <h1 className="text-2xl font-bold">tf-web probe</h1>
    <p className="mt-4 text-emerald-400">Tailwind working ✓</p>
    <div className="mt-4">
      <Button>shadcn Button</Button>
    </div>
  </div>,
);
