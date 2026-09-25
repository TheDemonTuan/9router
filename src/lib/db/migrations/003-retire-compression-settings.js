import { stripRetiredSettings } from "../helpers/retiredSettings.js";

export default {
  version: 3,
  name: "retire-compression-settings",
  up(db) {
    const row = db.get("SELECT data FROM settings WHERE id = 1");
    if (!row) return;
    let settings;
    try {
      settings = JSON.parse(row.data);
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error();
    } catch {
      throw new Error("Invalid persisted settings JSON");
    }
    const clean = stripRetiredSettings(settings);
    if (Object.keys(clean).length !== Object.keys(settings).length) {
      db.run("UPDATE settings SET data = ? WHERE id = 1", [JSON.stringify(clean)]);
    }
  },
};
