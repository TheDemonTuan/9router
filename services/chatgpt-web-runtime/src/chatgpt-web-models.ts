export const CHATGPT_WEB_MODEL_PREFIX = "chatgpt-web/";
export const CHATGPT_WEB_BACKEND_MODEL = "gpt-5.6-sol";
export const CHATGPT_WEB_LUNA_BACKEND_MODEL = "gpt-5.6-luna";

export type ChatGptWebAutomaticBackendModel =
  | typeof CHATGPT_WEB_BACKEND_MODEL
  | typeof CHATGPT_WEB_LUNA_BACKEND_MODEL;
export type ChatGptWebBackendModel = ChatGptWebAutomaticBackendModel;

export type ChatGptWebCodexEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type ChatGptWebAdapterEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type ChatGptWebModelFamily = "5.6" | "6";

/**
 * Measured Plus browser transport windows, including the fixed hidden ChatGPT platform reserve.
 * Codex compacts the visible task at the lower explicit threshold before the next browser turn is
 * compiled. The remaining headroom is owned by ChatGPT's product prompt and Codex Native schemas.
 */
export const CHATGPT_WEB_INSTANT_CONTEXT_WINDOW = 41_000;
export const CHATGPT_WEB_INSTANT_AUTO_COMPACT_TOKEN_LIMIT = 32_000;
export const CHATGPT_WEB_MEDIUM_HIGH_CONTEXT_WINDOW = 90_000;
export const CHATGPT_WEB_MEDIUM_HIGH_AUTO_COMPACT_TOKEN_LIMIT = 80_000;
export const CHATGPT_WEB_INSTANT_COMPOSER_CHAR_LIMIT = 211_256;
export const CHATGPT_WEB_MEDIUM_HIGH_COMPOSER_CHAR_LIMIT = 1_048_572;
/** Hidden ChatGPT product prompt and Codex Native schema reserve included in usage estimates. */
export const CHATGPT_WEB_PLATFORM_RESERVE_TOKENS = 8_192;
/** Reserve for each attachment in the final browser message; inert stages carry no images. */
export function chatGptWebImageTokenReserve(detail?: string): number {
  return detail === "original" ? 8_192 : 4_096;
}
/** Pro-account usable browser windows and separately measured one-message boundaries. */
export const CHATGPT_WEB_PRO_AUTO_COMPACT_TOKEN_LIMIT = 95_000;
export const CHATGPT_WEB_PRO_STANDARD_MESSAGE_TOKEN_LIMIT = 103_000;
export const CHATGPT_WEB_PRO_MODEL_MESSAGE_TOKEN_LIMIT = 104_000;
// Browser message maxima are inclusive, while the context preflight treats its ceiling as an
// exclusive upper bound. The extra token preserves the last accepted payload exactly.
export const CHATGPT_WEB_PRO_STANDARD_CONTEXT_WINDOW =
  CHATGPT_WEB_PRO_STANDARD_MESSAGE_TOKEN_LIMIT + CHATGPT_WEB_PLATFORM_RESERVE_TOKENS + 1;
export const CHATGPT_WEB_PRO_MODEL_CONTEXT_WINDOW =
  CHATGPT_WEB_PRO_MODEL_MESSAGE_TOKEN_LIMIT + CHATGPT_WEB_PLATFORM_RESERVE_TOKENS + 1;
export const CHATGPT_WEB_PRO_INSTANT_COMPOSER_CHAR_LIMIT = 545_000;
// Rechecked 2026-09-19: Pro-account Medium/High accept 500k characters but the server
// rejects larger messages with HTTP 413 (message_length_exceeds_limit), even below
// the token budget. Composer insertion itself still accepts them. Keep headroom;
// Instant and the Pro model have different bounds, not this reasoning-mode ceiling.
export const CHATGPT_WEB_PRO_REASONING_COMPOSER_CHAR_LIMIT = 500_000;
export const CHATGPT_WEB_PRO_MODEL_COMPOSER_CHAR_LIMIT = 1_635_000;
/**
 * The underlying Luna model owns this context window. ChatGPT Free's much smaller browser request
 * envelope is enforced separately at the browser boundary; rolling checkpoints keep completed
 * history out of later browser requests without asking Codex to compact its canonical history.
 */
export const CHATGPT_WEB_LUNA_CONTEXT_WINDOW = 1_050_000;
export const CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER = 3;
export const CHATGPT_WEB_GPT6_SOL_BIGGER_CONTEXT_WINDOW = 240_000;
export const CHATGPT_WEB_GPT6_SOL_BIGGER_AUTO_COMPACT_TOKEN_LIMIT = 220_000;
export const CHATGPT_WEB_GPT6_SOL_COMPOSER_CHAR_LIMIT = 500_000;

/** GPT-6 staged context is limited to the account and efforts verified upstream. */
export function supportsChatGptWebBiggerContext(
  backendModel: string,
  effort: ChatGptWebAdapterEffort,
  capabilities: Pick<ChatGptWebAccountCapabilities, "proAvailable">,
  modelFamily: ChatGptWebModelFamily | undefined,
): boolean {
  return backendModel === CHATGPT_WEB_BACKEND_MODEL && (
    modelFamily !== "6" || effort === "max" || (capabilities.proAvailable && effort !== "low")
  );
}

export interface ChatGptWebContextLimits {
  contextWindow: number;
  effectiveContextWindowPercent: number;
  autoCompactTokenLimit: number;
}

export interface ChatGptWebTransportLimits {
  browserMessageTokenLimit?: number;
  browserComposerCharLimit?: number;
}


function contextLimits(
  contextWindow: number,
  autoCompactTokenLimit: number,
): ChatGptWebContextLimits {
  return {
    contextWindow,
    // Codex reports this effective window in its context indicator. Align it with the practical
    // pre-compaction budget instead of exposing an unreachable underlying model window.
    effectiveContextWindowPercent: Math.round((autoCompactTokenLimit / contextWindow) * 100),
    autoCompactTokenLimit,
  };
}

/** Resolve the product limit for the selected visible ChatGPT mode. */
export function resolveChatGptWebContextLimits(
  backendModel: ChatGptWebBackendModel,
  effort: ChatGptWebAdapterEffort,
  capabilities: ChatGptWebAccountCapabilities,
  modelFamily: ChatGptWebModelFamily | undefined,
): ChatGptWebContextLimits {
  if (backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) {
    // Luna carries continuity through a private checkpoint on every completed browser turn. Codex
    // internally clamps this field to 90% of the model window, but the reported active usage is the
    // bounded payload actually sent to ChatGPT and therefore stays far below that threshold.
    return contextLimits(CHATGPT_WEB_LUNA_CONTEXT_WINDOW, CHATGPT_WEB_LUNA_CONTEXT_WINDOW);
  }

  let limits: ChatGptWebContextLimits;
  if (capabilities.proAvailable) {
    const contextWindow = effort === "low"
      ? CHATGPT_WEB_PRO_STANDARD_CONTEXT_WINDOW
      : effort === "max"
        ? CHATGPT_WEB_PRO_MODEL_CONTEXT_WINDOW
        : CHATGPT_WEB_PRO_STANDARD_CONTEXT_WINDOW;
    limits = contextLimits(contextWindow, CHATGPT_WEB_PRO_AUTO_COMPACT_TOKEN_LIMIT);
  } else if (effort === "low") {
    limits = contextLimits(
      CHATGPT_WEB_INSTANT_CONTEXT_WINDOW,
      CHATGPT_WEB_INSTANT_AUTO_COMPACT_TOKEN_LIMIT,
    );
  } else if (effort === "medium" || effort === "high" || (effort === "xhigh" && capabilities.extraHighAvailable)) {
    limits = contextLimits(
      CHATGPT_WEB_MEDIUM_HIGH_CONTEXT_WINDOW,
      CHATGPT_WEB_MEDIUM_HIGH_AUTO_COMPACT_TOKEN_LIMIT,
    );
  } else {
    throw new Error(`ChatGPT Plus context limit is not defined for unavailable effort: ${effort}`);
  }
  if (!capabilities.experimentalBiggerContext
    || !supportsChatGptWebBiggerContext(backendModel, effort, capabilities, modelFamily)) return limits;
  if (modelFamily === "6" && effort !== "max") {
    return contextLimits(
      CHATGPT_WEB_GPT6_SOL_BIGGER_CONTEXT_WINDOW,
      CHATGPT_WEB_GPT6_SOL_BIGGER_AUTO_COMPACT_TOKEN_LIMIT,
    );
  }
  return contextLimits(
    limits.contextWindow * CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER,
    limits.autoCompactTokenLimit * CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER,
  );
}

/** Resolve limits of one visible ChatGPT composer message, independently of model context. */
export function resolveChatGptWebTransportLimits(
  backendModel: ChatGptWebBackendModel,
  effort: ChatGptWebAdapterEffort,
  capabilities: ChatGptWebAccountCapabilities,
  modelFamily: ChatGptWebModelFamily | undefined,
): ChatGptWebTransportLimits {
  if (backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) return {};
  if (!capabilities.proAvailable) {
    if (effort === "low") {
      return { browserComposerCharLimit: CHATGPT_WEB_INSTANT_COMPOSER_CHAR_LIMIT };
    }
    if (effort === "medium" || effort === "high" || (effort === "xhigh" && capabilities.extraHighAvailable)) {
      return { browserComposerCharLimit: modelFamily === "6"
        ? CHATGPT_WEB_GPT6_SOL_COMPOSER_CHAR_LIMIT : CHATGPT_WEB_MEDIUM_HIGH_COMPOSER_CHAR_LIMIT };
    }
    throw new Error(`ChatGPT Plus transport limit is not defined for unavailable effort: ${effort}`);
  }
  if (effort === "low") {
    return {
      browserMessageTokenLimit: CHATGPT_WEB_PRO_STANDARD_MESSAGE_TOKEN_LIMIT,
      browserComposerCharLimit: CHATGPT_WEB_PRO_INSTANT_COMPOSER_CHAR_LIMIT,
    };
  }
  if (effort === "max") {
    return {
      browserMessageTokenLimit: CHATGPT_WEB_PRO_MODEL_MESSAGE_TOKEN_LIMIT,
      browserComposerCharLimit: CHATGPT_WEB_PRO_MODEL_COMPOSER_CHAR_LIMIT,
    };
  }
  return {
    browserMessageTokenLimit: CHATGPT_WEB_PRO_STANDARD_MESSAGE_TOKEN_LIMIT,
    browserComposerCharLimit: CHATGPT_WEB_PRO_REASONING_COMPOSER_CHAR_LIMIT,
  };
}

/**
 * Visible text that fits one ordinary input after its hidden reserve and images. This is derived
 * from the existing context contract, not a new measured browser limit or a compaction trigger.
 * Bigger Context expands the transaction, never this per-message budget.
 */
export function resolveChatGptWebMessageTokenBudget(
  backendModel: typeof CHATGPT_WEB_BACKEND_MODEL,
  effort: ChatGptWebAdapterEffort,
  capabilities: ChatGptWebAccountCapabilities,
  modelFamily: ChatGptWebModelFamily | undefined,
  imageTokens = 0,
): number {
  const { contextWindow } = resolveChatGptWebContextLimits(
    backendModel, effort, { ...capabilities, experimentalBiggerContext: false }, modelFamily,
  );
  const { browserMessageTokenLimit } = resolveChatGptWebTransportLimits(backendModel, effort, capabilities, modelFamily);
  return Math.max(0, Math.min(
    contextWindow - CHATGPT_WEB_PLATFORM_RESERVE_TOKENS - imageTokens - 1,
    browserMessageTokenLimit ?? Infinity,
  ));
}

interface ChatGptWebModelRouteBase {
  slug: string;
  displayName: string;
  description: string;
  codexEffort: ChatGptWebCodexEffort;
  requiresPro: boolean;
  requiresExtraHigh?: boolean;
  /** Old task identities remain resolvable, but are omitted from the picker. */
  legacy?: boolean;
  /** Omission denotes an immutable route, including all pre-6.0 task identities. */
  supportedCodexEfforts?: readonly ChatGptWebCodexEffort[];
}

export interface ChatGptWebAutomaticModelRoute extends ChatGptWebModelRouteBase {
  interactionMode: "automatic";
  backendModel: ChatGptWebAutomaticBackendModel;
  adapterEffort: ChatGptWebAdapterEffort;
  /** Exact browser family, independent of the generic adapter's context/transport profile. */
  modelFamily?: ChatGptWebModelFamily;
}


export type ChatGptWebModelRoute = ChatGptWebAutomaticModelRoute;

export interface ChatGptWebAccountCapabilities {
  solAvailable: boolean;
  /** Missing in older saved observations; setup must probe before exposing Extra High. */
  extraHighAvailable?: boolean;
  proAvailable: boolean;
  experimentalBiggerContext?: boolean;
}


export const CHATGPT_WEB_LEGACY_LUNA_MODEL_ROUTE: ChatGptWebAutomaticModelRoute = {
  slug: "chatgpt-web/luna",
  displayName: "ChatGPT Web — Luna",
  description: "ChatGPT Web Luna for accounts without the Sol model selector.",
  interactionMode: "automatic",
  backendModel: CHATGPT_WEB_LUNA_BACKEND_MODEL,
  codexEffort: "low",
  adapterEffort: "low",
  requiresPro: false,
  legacy: true,
};

export const CHATGPT_WEB_LUNA_THINK_MODEL_ROUTE: ChatGptWebModelRoute = {
  slug: "chatgpt-web/think",
  displayName: "ChatGPT Web — Think",
  description: "ChatGPT Web Think for Luna-only accounts.",
  interactionMode: "automatic",
  backendModel: CHATGPT_WEB_LUNA_BACKEND_MODEL,
  codexEffort: "low",
  // The backend model remains Luna. This internal adapter effort distinguishes the explicit
  // Think route after Codex has selected its separate catalog row.
  adapterEffort: "medium",
  requiresPro: false,
  legacy: true,
};

export const CHATGPT_WEB_LUNA_MODEL_ROUTE: ChatGptWebAutomaticModelRoute = {
  slug: "chatgpt-web/gpt-5.6-luna",
  displayName: "GPT-5.6 Luna (Web)",
  description: "ChatGPT Luna. Light selects the ordinary mode; Medium enables Think.",
  interactionMode: "automatic",
  backendModel: CHATGPT_WEB_LUNA_BACKEND_MODEL,
  codexEffort: "low",
  adapterEffort: "low",
  supportedCodexEfforts: ["low", "medium"],
  requiresPro: false,
};

export const CHATGPT_WEB_LUNA_MODEL_ROUTES: readonly ChatGptWebModelRoute[] = [
  CHATGPT_WEB_LUNA_MODEL_ROUTE,
];

/**
 * Preserve the exact pre-6.0 bindings for saved tasks, including the old unpinned Pro route.
 * Native Codex may normalize its technical effort; these identities have always owned the mode.
 */
export const CHATGPT_WEB_LEGACY_MODEL_ROUTES: readonly ChatGptWebAutomaticModelRoute[] = [
  {
    slug: "chatgpt-web/light",
    displayName: "ChatGPT Web — Instant",
    description: "ChatGPT Web Instant through the native Codex harness.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    codexEffort: "low",
    adapterEffort: "low",
    requiresPro: false,
    legacy: true,
  },
  {
    slug: "chatgpt-web/medium",
    displayName: "ChatGPT Web — Medium",
    description: "ChatGPT Web Medium through the native Codex harness.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    codexEffort: "medium",
    adapterEffort: "medium",
    requiresPro: false,
    legacy: true,
  },
  {
    slug: "chatgpt-web/high",
    displayName: "ChatGPT Web — High",
    description: "ChatGPT Web High through the native Codex harness.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    codexEffort: "high",
    adapterEffort: "high",
    requiresPro: false,
    legacy: true,
  },
  {
    slug: "chatgpt-web/extra-high",
    displayName: "ChatGPT Web — Extra High",
    description: "Account-gated ChatGPT Web Extra High through the native Codex harness.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    codexEffort: "xhigh",
    adapterEffort: "xhigh",
    requiresPro: false,
    requiresExtraHigh: true,
    legacy: true,
  },
  {
    slug: "chatgpt-web/pro",
    displayName: "ChatGPT Web — Pro",
    description: "Account-gated ChatGPT Pro through the native Codex harness.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    codexEffort: "ultra",
    adapterEffort: "max",
    requiresPro: true,
    legacy: true,
  },
];

/** Group only efforts with identical context and compaction budgets. */
export const CHATGPT_WEB_MODEL_ROUTES: readonly ChatGptWebAutomaticModelRoute[] = [
  {
    slug: "chatgpt-web/gpt-5.6-sol-instant",
    displayName: "GPT-5.6 Sol Instant (Web)",
    description: "GPT-5.6 Sol Instant through ChatGPT, with its own context and compaction budget.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    modelFamily: "5.6",
    codexEffort: "low",
    adapterEffort: "low",
    supportedCodexEfforts: ["low"],
    requiresPro: false,
  },
  {
    slug: "chatgpt-web/gpt-5.6-sol",
    displayName: "GPT-5.6 Sol (Web)",
    description: "GPT-5.6 Sol through ChatGPT with Medium, High, or account-supported Extra High reasoning.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    modelFamily: "5.6",
    codexEffort: "high",
    adapterEffort: "high",
    supportedCodexEfforts: ["medium", "high", "xhigh"],
    requiresPro: false,
  },
  {
    slug: "chatgpt-web/gpt-5.6-pro",
    displayName: "GPT-5.6 Pro (Web)",
    description: "GPT-5.6 Pro through ChatGPT. The fixed Max effort selects Pro.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    modelFamily: "5.6",
    codexEffort: "max",
    adapterEffort: "max",
    supportedCodexEfforts: ["max"],
    requiresPro: true,
  },
  {
    slug: "chatgpt-web/gpt-6-sol-instant",
    displayName: "GPT-6 Sol Instant (Web)",
    description: "GPT-6 Sol Instant through ChatGPT, with its own context and compaction budget.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    modelFamily: "6",
    codexEffort: "low",
    adapterEffort: "low",
    supportedCodexEfforts: ["low"],
    requiresPro: false,
  },
  {
    slug: "chatgpt-web/gpt-6-sol",
    displayName: "GPT-6 Sol (Web)",
    description: "GPT-6 Sol through ChatGPT with Medium, High, or account-supported Extra High reasoning.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    modelFamily: "6",
    codexEffort: "high",
    adapterEffort: "high",
    supportedCodexEfforts: ["medium", "high", "xhigh"],
    requiresPro: false,
  },
  {
    slug: "chatgpt-web/gpt-6-pro",
    displayName: "GPT-6 Pro (Web)",
    description: "GPT-6 Pro through ChatGPT. The fixed Max effort selects Pro.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    modelFamily: "6",
    codexEffort: "max",
    adapterEffort: "max",
    supportedCodexEfforts: ["max"],
    requiresPro: true,
  },
];

const routesBySlug = new Map(
  [
    ...CHATGPT_WEB_LUNA_MODEL_ROUTES,
    ...CHATGPT_WEB_MODEL_ROUTES,
    CHATGPT_WEB_LEGACY_LUNA_MODEL_ROUTE,
    CHATGPT_WEB_LUNA_THINK_MODEL_ROUTE,
    ...CHATGPT_WEB_LEGACY_MODEL_ROUTES,
  ]
    .map(route => [route.slug, route]),
);

export function isChatGptWebModelSlug(modelId: string): boolean {
  return modelId.startsWith(CHATGPT_WEB_MODEL_PREFIX);
}

export function availableChatGptWebModelRoutes(
  capabilities: ChatGptWebAccountCapabilities,
  includeLegacy = false,
): readonly ChatGptWebModelRoute[] {
  if (!capabilities.solAvailable) return includeLegacy
    ? [...CHATGPT_WEB_LUNA_MODEL_ROUTES, CHATGPT_WEB_LEGACY_LUNA_MODEL_ROUTE, CHATGPT_WEB_LUNA_THINK_MODEL_ROUTE]
    : CHATGPT_WEB_LUNA_MODEL_ROUTES;
  const candidates = includeLegacy
    ? [...CHATGPT_WEB_MODEL_ROUTES, ...CHATGPT_WEB_LEGACY_MODEL_ROUTES]
    : CHATGPT_WEB_MODEL_ROUTES;
  return candidates.filter(route =>
    (!route.requiresPro || capabilities.proAvailable)
    && (!route.requiresExtraHigh || capabilities.extraHighAvailable));
}

export function chatGptWebRouteEfforts(
  route: ChatGptWebModelRoute,
  capabilities: ChatGptWebAccountCapabilities,
): readonly ChatGptWebCodexEffort[] {
  return (route.supportedCodexEfforts ?? [route.codexEffort])
    .filter(effort => effort !== "xhigh" || capabilities.extraHighAvailable === true);
}

export function requireChatGptWebModelRoute(
  modelId: string,
  capabilities: ChatGptWebAccountCapabilities,
  reasoning?: string,
): ChatGptWebModelRoute {
  const route = routesBySlug.get(modelId);
  if (!route) throw new Error(`ChatGPT web model is not enabled: ${modelId}`);
  if (route.backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) {
    if (capabilities.solAvailable) {
      throw new Error(`${route.displayName} is only available for Luna-only accounts`);
    }
    return resolveRouteEffort(route, capabilities, reasoning);
  }
  if (!capabilities.solAvailable) {
    throw new Error(`${route.displayName} is not available for this Luna-only account`);
  }
  if ((route.requiresPro && !capabilities.proAvailable)
    || (route.requiresExtraHigh && !capabilities.extraHighAvailable)) {
    throw new Error(`${route.displayName} is not available for this account`);
  }
  return resolveRouteEffort(route, capabilities, reasoning);
}

function resolveRouteEffort(
  route: ChatGptWebAutomaticModelRoute,
  capabilities: ChatGptWebAccountCapabilities,
  reasoning?: string,
): ChatGptWebAutomaticModelRoute {
  if (!route.supportedCodexEfforts) return route;
  const effort = reasoning ?? route.codexEffort;
  if (!chatGptWebRouteEfforts(route, capabilities).includes(effort as ChatGptWebCodexEffort)) {
    throw new Error(`${route.displayName} does not support effort ${JSON.stringify(effort)} for this account`);
  }
  if (effort === route.codexEffort) return route;
  return { ...route, codexEffort: effort as ChatGptWebCodexEffort, adapterEffort: effort as ChatGptWebAdapterEffort };
}
