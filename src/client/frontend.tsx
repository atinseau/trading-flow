import { Toaster } from "@client/components/ui/sonner";
import { queryClient } from "@client/lib/queryClient";
import { ErrorPage } from "@client/routes/error";
import { RootLayout } from "@client/routes/root";
import { QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";

import "./globals.css";

const router = createBrowserRouter([
  {
    path: "/",
    element: <RootLayout />,
    errorElement: <ErrorPage />,
    children: [
      { index: true, lazy: () => import("@client/routes/dashboard") },
      { path: "search", lazy: () => import("@client/routes/search") },
      { path: "assets/:source/:symbol", lazy: () => import("@client/routes/asset") },
      { path: "watches/new", lazy: () => import("@client/routes/watch-new") },
      { path: "watches/:id", lazy: () => import("@client/routes/watch") },
      { path: "setups/:id", lazy: () => import("@client/routes/setup") },
      { path: "live-events", lazy: () => import("@client/routes/live-events") },
      { path: "costs", lazy: () => import("@client/routes/costs") },
    ],
  },
]);

const container = document.getElementById("root") ?? document.body;
createRoot(container).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster richColors />
    </QueryClientProvider>
  </React.StrictMode>,
);
