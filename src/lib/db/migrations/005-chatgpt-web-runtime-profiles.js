const PROFILE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const validProfileId = value => typeof value === "string" && PROFILE_ID.test(value);

function objectJson(raw, context) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error(`Invalid persisted ${context} JSON; repair the database before migrating ChatGPT Web`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid persisted ${context} object`);
  return value;
}

// The registry runs up() and the schema-version stamp in one transaction.
export default {
  version: 5,
  name: "chatgpt-web-runtime-profiles",
  up(db) {
    for (const row of db.all("SELECT id, data, isActive FROM providerConnections WHERE provider = ?", ["chatgpt-web"])) {
      const data = objectJson(row.data, `ChatGPT Web connection ${row.id}`);
      const selectors = data.providerSpecificData;
      const hasProfile = selectors && Object.hasOwn(selectors, "profileId");
      const hasBridge = selectors && Object.hasOwn(selectors, "bridgeId");
      const profileId = hasProfile ? selectors.profileId : selectors?.bridgeId;
      const invalid = !validProfileId(profileId) || (hasBridge && (!validProfileId(selectors.bridgeId) || (hasProfile && selectors.bridgeId !== profileId)));
      data.providerSpecificData = validProfileId(profileId) && !invalid ? { profileId } : {};
      if (invalid) {
        data.testStatus = "error";
        data.errorCode = "cgw_profile_migration_required";
        data.lastError = "ChatGPT Web profile migration requires an explicit valid profileId. Conflicting or invalid legacy selectors were not guessed; configure the runtime profile, update this connection and re-enable it. Existing socket conversations cannot resume.";
      }
      db.run("UPDATE providerConnections SET data = ?, isActive = ? WHERE id = ?", [JSON.stringify(data), invalid ? 0 : row.isActive, row.id]);
    }
    for (const row of db.all("SELECT key, value FROM kv WHERE scope = ?", ["chatgptWebPins"])) {
      const pin = objectJson(row.value, "ChatGPT Web legacy pin");
      const tombstone = { status: "legacy_unavailable", ...(Object.hasOwn(pin, "lastUsed") ? { lastUsed: pin.lastUsed } : {}) };
      db.run("INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value", ["chatgptWebLegacyPins", row.key, JSON.stringify(tombstone)]);
    }
    db.run("DELETE FROM kv WHERE scope = ?", ["chatgptWebPins"]);
  },
};
