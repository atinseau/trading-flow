import path from "node:path";
import type { WorkerOptions } from "@temporalio/worker";
import { TsconfigPathsPlugin } from "tsconfig-paths-webpack-plugin";

const tsconfig = path.resolve(import.meta.dir, "../../tsconfig.json");

export const workflowBundlerOptions: WorkerOptions["bundlerOptions"] = {
  webpackConfigHook: (config) => {
    config.resolve = config.resolve ?? {};
    config.resolve.plugins = [
      ...(config.resolve.plugins ?? []),
      new TsconfigPathsPlugin({ configFile: tsconfig, extensions: [".ts", ".js"] }),
    ];
    return config;
  },
};
