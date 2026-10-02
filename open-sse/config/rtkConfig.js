export const RTK_CONFIG = Object.freeze({
  protocolVersion: 1,
  minTextBytes: 500,
  maxTextBytes: 10_485_760,
  maxHttpBytes: 12_582_912,
  requestMs: 1500,
  connectMs: 150,
  subprocessMs: 1000,
  cooldownMs: 30_000,
  statusPollMs: 5000,
  statusRequestMs: 5000,
  checkCooldownMs: 10_000,
  checkMaxHttpBytes: 65_536,
  perRequestConcurrency: 2,
  gatewayConcurrency: 4,
  sidecarConcurrency: 4,
  maxSelectedBytes: 10_485_760,
  diagnosticMaxRows: 128,
});

export const RTK_REJECTIONS = Object.freeze([
  "error_result", "cache_marker", "cache_fence", "opaque_state", "dedup_anchor", "dedup_candidate", "dedup_marker", "below_min_bytes", "above_max_bytes", "selection_budget", "unlinked_call",
  "invalid_command_metadata", "metadata_limit", "missing_command", "unsupported_shell_syntax",
  "not_applicable_tool", "native_metadata_missing",
  "recognized_preserved", "envelope_rejected",
  "already_rtk", "unsupported_command", "unsupported_mode", "unsupported_output_format",
]);

export const RTK_PIPE_FILTERS = Object.freeze([
  "cargo-test", "cargo", "pytest", "go-test", "go-build", "ctest", "tsc", "vitest",
  "grep", "rg", "find", "fd", "git-log", "git-diff", "git-status", "log", "mypy",
  "ruff-check", "ruff-format", "sqlfluff-lint", "prettier", "phpunit", "pest",
  "paratest", "php-test", "ecs", "phpstan", "pint",
]);

export const RTK_FILTERS = RTK_PIPE_FILTERS;

export const RTK_LOCAL_FILTERS = Object.freeze([
  "local:git-log", "local:grep", "local:find", "local:test", "local:cargo-build",
  "local:docker-ps", "local:docker-logs", "local:listing",
]);

// Filters that 9router classifier actually routes to (distinguishing pipe vs local engine)
export const RTK_ROUTABLE_FILTERS = Object.freeze([
  ...RTK_LOCAL_FILTERS,
  "cargo-test", "pytest", "go-test", "go-build", "ctest", "tsc", "vitest",
  "grep", "git-status", "mypy", "ruff-check", "ruff-format",
  "sqlfluff-lint", "prettier", "phpunit", "pest", "paratest", "ecs", "phpstan", "pint",
]);

export const RTK_TOOL_FAMILIES = Object.freeze([
  "shell", "grep", "glob", "read", "edit", "write", "other", "unlinked",
]);

export const RTK_COMMAND_FAMILIES = Object.freeze([
  "git diff", "git status", "git log", "git other",
  "npm test", "pnpm test", "yarn test", "bun test", "npm other", "pnpm other", "yarn other", "bun other",
  "node test", "node other", "cargo test", "cargo build", "cargo other", "go test", "go build", "go other",
  "docker ps", "docker logs", "docker other", "ruff check", "ruff format", "ruff other", "sqlfluff lint", "sqlfluff other",
  "pytest", "ctest", "tsc", "vitest", "jest", "mypy", "prettier", "phpunit", "pest", "paratest", "ecs", "phpstan", "pint",
  "rg", "grep", "find", "fd", "ls", "tree", "rtk", "eslint", "biome", "playwright", "make", "other",
]);

export const RTK_TRACKED_FAMILIES = Object.freeze([
  "shell", "grep", "glob",
]);
export const RTK_DIAGNOSTIC_DETAILS = Object.freeze([
  "none", "no_command", "native_metadata_missing", "native_output_mismatch",
  "serialized_metadata_limit", "command_length_limit",
  "already_grouped", "lossy_filter", "non_patch", "metadata", "grammar", "unsafe_body", "carrier_context",
]);

export const RTK_FILTER_DETAILS = Object.freeze([
  "none", "unknown_terminal_control", "failure_detected", "multiple_runs",
  "unsupported_structure", "unknown_reporter", "missing_footer", "incomplete_run",
  "totals_mismatch", "no_removable_rows", "already_grouped",
]);

export const RTK_NATIVE_GREP_SHAPES = Object.freeze(["flat_numbered", "heading_numbered", "omp_grouped", "opencode_heading", "unknown"]);

export const RTK_DIAGNOSTIC_OUTCOMES = Object.freeze([
  "applied", "discarded_deadline", "discarded_cancelled", "not_smaller", "empty_output",
  "invalid_text", "format_not_accepted", "busy", "rejected", "timeout", "cancelled", "failed",
  "skip_unconfigured", "skip_invalid_url", "skip_invalid_text", "skip_size_limit",
  "skip_circuit_open", "skip_probe_in_flight", "skip_saturated", "skip_payload_limit",
]);
