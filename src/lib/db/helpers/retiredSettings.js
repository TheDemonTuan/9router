export function stripRetiredSettings(settings) {
  if (settings == null) return {};
  if (typeof settings !== "object" || Array.isArray(settings)) throw new Error("Invalid settings object");
  return Object.fromEntries(Object.entries(settings).filter(([key]) => !/^headroom/i.test(key)));
}
