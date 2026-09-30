const migration = {
  version: 4,
  name: "migrate-session-dedup-shadow-to-off",
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
    if (settings.sessionDedupMode === "shadow") {
      settings.sessionDedupMode = "off";
      db.run("UPDATE settings SET data = ? WHERE id = 1", [JSON.stringify(settings)]);
    }
  },
};

export default migration;
