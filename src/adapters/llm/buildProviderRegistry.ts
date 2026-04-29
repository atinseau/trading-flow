import type { InfraConfig } from "@config/InfraConfig";
import type { LLMProvider } from "@domain/ports/LLMProvider";
import type { LLMUsageStore } from "@domain/ports/LLMUsageStore";
import { validateProviderGraph } from "@domain/services/validateProviderGraph";
import { ClaudeAgentSdkProvider } from "./ClaudeAgentSdkProvider";
import { OpenRouterProvider } from "./OpenRouterProvider";

type ProviderDefault =
  | {
      type: "claude-agent-sdk";
      daily_call_budget?: number;
      fallback: string | null;
    }
  | {
      type: "openrouter";
      base_url?: string;
      monthly_budget_usd?: number;
      fallback: string | null;
    };

const PROVIDER_DEFAULTS: Record<string, ProviderDefault> = {
  claude_max: {
    type: "claude-agent-sdk",
    daily_call_budget: 800,
    fallback: "openrouter",
  },
  openrouter: {
    type: "openrouter",
    monthly_budget_usd: 50,
    fallback: null,
  },
};

export function buildProviderRegistry(
  infra: InfraConfig,
  usageStore?: LLMUsageStore,
): Map<string, LLMProvider> {
  const registry = new Map<string, LLMProvider>();

  for (const [name, providerCfg] of Object.entries(PROVIDER_DEFAULTS)) {
    if (providerCfg.type === "claude-agent-sdk") {
      registry.set(
        name,
        new ClaudeAgentSdkProvider(name, {
          workspaceDir: infra.claude.workspace_dir,
          dailyCallBudget: providerCfg.daily_call_budget,
          fallback: providerCfg.fallback,
          usageStore,
        }),
      );
    } else {
      if (infra.llm.openrouter_api_key === null) {
        throw new Error(
          `OPENROUTER_API_KEY is required because provider "${name}" type = openrouter`,
        );
      }
      registry.set(
        name,
        new OpenRouterProvider(name, {
          apiKey: infra.llm.openrouter_api_key,
          baseUrl: providerCfg.base_url,
          monthlyBudgetUsd: providerCfg.monthly_budget_usd,
          fallback: providerCfg.fallback,
          usageStore,
        }),
      );
    }
  }

  // Defense in depth — even if PROVIDER_DEFAULTS is edited badly later
  const graphForValidation: Record<string, { fallback: string | null }> = {};
  for (const [name, p] of registry) graphForValidation[name] = { fallback: p.fallback };
  validateProviderGraph(graphForValidation);

  return registry;
}
