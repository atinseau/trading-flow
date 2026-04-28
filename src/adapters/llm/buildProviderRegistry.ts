import type { LLMProvider } from "@domain/ports/LLMProvider";
import type { LLMUsageStore } from "@domain/ports/LLMUsageStore";
import type { Config } from "@domain/schemas/Config";
import { validateProviderGraph } from "@domain/services/validateProviderGraph";
import { ClaudeAgentSdkProvider } from "./ClaudeAgentSdkProvider";
import { OpenRouterProvider } from "./OpenRouterProvider";

export function buildProviderRegistry(
  config: Config,
  usageStore?: LLMUsageStore,
): Map<string, LLMProvider> {
  const registry = new Map<string, LLMProvider>();

  for (const [name, providerCfg] of Object.entries(config.llm_providers)) {
    if (providerCfg.type === "claude-agent-sdk") {
      registry.set(
        name,
        new ClaudeAgentSdkProvider(name, {
          workspaceDir: providerCfg.workspace_dir,
          dailyCallBudget: providerCfg.daily_call_budget,
          fallback: providerCfg.fallback,
          usageStore,
        }),
      );
    } else if (providerCfg.type === "openrouter") {
      registry.set(
        name,
        new OpenRouterProvider(name, {
          apiKey: providerCfg.api_key,
          baseUrl: providerCfg.base_url,
          monthlyBudgetUsd: providerCfg.monthly_budget_usd,
          fallback: providerCfg.fallback,
          usageStore,
        }),
      );
    }
  }

  // runtime safety: re-validate the graph (config validates too, but defense in depth)
  const graphForValidation: Record<string, { fallback: string | null }> = {};
  for (const [name, p] of registry) graphForValidation[name] = { fallback: p.fallback };
  validateProviderGraph(graphForValidation);

  return registry;
}
