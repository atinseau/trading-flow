import type { StorybookConfig } from "@storybook/react-vite";
import tailwind from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-docs", "@storybook/addon-a11y", "@storybook/addon-vitest"],
  framework: { name: "@storybook/react-vite", options: {} },
  viteFinal: (cfg) => {
    cfg.plugins = [...(cfg.plugins ?? []), tsconfigPaths(), tailwind()];
    return cfg;
  },
};
export default config;
