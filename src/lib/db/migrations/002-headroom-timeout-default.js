import { HEADROOM_DEFAULT_TIMEOUT_MS } from "../../../../open-sse/config/runtimeConfig.js";

const headroomTimeoutDefault = {
  version: 2,
  name: "headroom-timeout-default",
  up(db) {
    const row = db.get("SELECT data FROM settings WHERE id = 1");
    if (!row) return;
    let settings;
    try {
      settings = JSON.parse(row.data);
    } catch {
      console.warn("[DB][migrate] invalid settings JSON; headroom timeout left unchanged");
      return;
    }
    if (!settings || typeof settings !== "object" || Array.isArray(settings) || settings.headroomTimeoutMs !== 3000) return;
    settings.headroomTimeoutMs = HEADROOM_DEFAULT_TIMEOUT_MS;
    db.run("UPDATE settings SET data = ? WHERE id = 1", [JSON.stringify(settings)]);
  },
};

export default headroomTimeoutDefault;
