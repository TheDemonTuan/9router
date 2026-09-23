const PUBLIC_CAPABILITIES = new Set([
  "tools",
  "search",
  "structured_output",
  "mid_conversation_system",
]);

const BASE_MODEL_KEYS = [
  "id",
  "object",
  "owned_by",
  "name",
  "context_length",
  "max_completion_tokens",
  "input_modalities",
  "output_modalities",
  "default_reasoning_level",
  "supported_reasoning_levels",
  "capabilities",
  "kind",
  "created",
];

const VARIANT_KEYS = [
  "id",
  "object",
  "owned_by",
  "base_model",
  "reasoning_effort",
  "virtual",
];

const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const unixSeconds = (value) => positiveInteger(value) && value <= 253402300799;

export function projectPublicCapabilities(value, evidence = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const capabilities = Object.fromEntries(
    Object.entries(value).filter(([key, flag]) => PUBLIC_CAPABILITIES.has(key)
      && (flag === true || (flag === false && evidence[key] === false))),
  );
  return Object.keys(capabilities).length ? capabilities : undefined;
}

function projectInputModalities(value, capabilities, evidence) {
  if (Array.isArray(value)) return [...new Set(value.filter((item) => typeof item === "string"))];
  if (capabilities?.vision === true || evidence.vision === true) return ["text", "image"];
  return undefined;
}

function capabilityEvidence(model) {
  return {
    ...(Array.isArray(model.supported_reasoning_levels ?? model.supportedReasoningLevels)
      ? { reasoning: (model.supported_reasoning_levels ?? model.supportedReasoningLevels).length > 0 }
      : {}),
    ...(Array.isArray(model.input_modalities ?? model.inputModalities)
      ? { vision: (model.input_modalities ?? model.inputModalities).includes("image") }
      : {}),
  };
}

export function projectPublicModel(model) {
  if (!model?.id || model.object !== "model") return null;
  const isVariant = model.virtual === true;
  const keys = isVariant ? VARIANT_KEYS : BASE_MODEL_KEYS;
  const projected = {};
  for (const key of keys) {
    if (key === "context_length" || key === "max_completion_tokens") {
      const value = model[key] ?? (key === "context_length" ? model.contextLength : model.maxOutputTokens);
      if (positiveInteger(value)) projected[key] = value;
    } else if (key === "input_modalities") {
      const value = model.input_modalities ?? model.inputModalities;
      const evidence = { ...capabilityEvidence(model), ...model.publicCapabilityEvidence };
      const modalities = value !== undefined || model.capabilities?.vision === true || evidence.vision === true
        ? projectInputModalities(value, model.capabilities, evidence)
        : undefined;
      if (modalities?.length) projected[key] = modalities;
    } else if (key === "output_modalities") {
      const modalities = model.output_modalities ?? model.outputModalities;
      const distinct = Array.isArray(modalities)
        ? [...new Set(modalities.filter((item) => typeof item === "string"))]
        : [];
      if (distinct.length && (distinct.length !== 1 || distinct[0] !== "text")) projected[key] = distinct;
    } else if (key === "supported_reasoning_levels") {
      const levels = model.supported_reasoning_levels ?? model.supportedReasoningLevels;
      if (Array.isArray(levels)) projected[key] = levels.filter((level) => typeof level === "string");
    } else if (key === "default_reasoning_level") {
      const level = model.default_reasoning_level ?? model.defaultReasoningLevel;
      const levels = model.supported_reasoning_levels ?? model.supportedReasoningLevels;
      if (typeof level === "string" && (!Array.isArray(levels) || levels.includes(level))) projected[key] = level;
    } else if (key === "capabilities") {
      const capabilities = projectPublicCapabilities(model.capabilities, {
        ...capabilityEvidence(model),
        ...model.publicCapabilityEvidence,
      });
      if (capabilities) projected[key] = capabilities;
    } else if (key === "kind") {
      if (typeof model.kind === "string" && model.kind !== "llm") projected[key] = model.kind;
    } else if (key === "created") {
      if (unixSeconds(model.created)) projected[key] = model.created;
    } else if (model[key] !== undefined && model[key] !== null) {
      projected[key] = model[key];
    }
  }
  return projected;
}
