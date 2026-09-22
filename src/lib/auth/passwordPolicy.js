const LOCAL_DEFAULT_PASSWORD = "123456";
const PRODUCTION_PLACEHOLDERS = new Set([
  "123456",
  "change-me",
  "change-this-production-password",
  "your-password",
  "password",
  "password123",
  "changeme",
]);

export function getInitialPassword() {
  const configured = process.env.INITIAL_PASSWORD?.trim();
  return configured || (process.env.NODE_ENV === "production" ? null : LOCAL_DEFAULT_PASSWORD);
}

export function hasConfiguredInitialPassword() {
  return Boolean(process.env.INITIAL_PASSWORD?.trim());
}

export function isUnsafeProductionInitialPassword(password) {
  const normalized = typeof password === "string" ? password.trim().toLowerCase() : "";
  return process.env.NODE_ENV === "production"
    && (!normalized || normalized.length < 12 || PRODUCTION_PLACEHOLDERS.has(normalized));
}
