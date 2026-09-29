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
  checkCooldownMs: 10_000,
  checkMaxHttpBytes: 65_536,
  perRequestConcurrency: 2,
  gatewayConcurrency: 4,
  sidecarConcurrency: 4,
  maxSelectedBytes: 10_485_760,
});

export const RTK_REJECTIONS = Object.freeze([
  "error_result", "cache_marker", "below_min_bytes", "above_max_bytes", "selection_budget", "unlinked_call",
  "invalid_command_metadata", "metadata_limit", "missing_command", "unsupported_shell_syntax",
  "already_rtk", "unsupported_command", "unsupported_mode", "unsupported_output_format",
]);

export const RTK_FILTERS = Object.freeze([
  "cargo-test", "cargo", "pytest", "go-test", "go-build", "ctest", "tsc", "vitest",
  "grep", "rg", "find", "fd", "git-log", "git-diff", "git-status", "log", "mypy",
  "ruff-check", "ruff-format", "sqlfluff-lint", "prettier", "phpunit", "pest",
  "paratest", "php-test", "ecs", "phpstan", "pint",
]);

export const RTK_LOCAL_FILTERS = Object.freeze([
  "local:git-log", "local:grep", "local:find", "local:test", "local:cargo-build",
  "local:docker-ps", "local:docker-logs", "local:listing",
]);
