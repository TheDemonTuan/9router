import { getAdapter } from "../driver.js";

/**
 * Try to acquire or renew a named lease.
 * Returns true if successfully acquired/renewed, false if held by another active process.
 *
 * @param {string} name - Lease name (e.g. "background_token_refresh")
 * @param {string} holder - Unique identifier of the caller/instance
 * @param {number} [ttlMs=30000] - Lease duration in milliseconds
 * @returns {Promise<boolean>}
 */
export async function acquireLease(name, holder, ttlMs = 30000) {
  const db = await getAdapter();
  const now = Date.now();
  const expiresAt = now + ttlMs;

  return db.transaction(() => {
    const existing = db.get(
      "SELECT holder, expires_at FROM runtime_leases WHERE name = ?",
      [name]
    );

    if (!existing) {
      db.run(
        "INSERT INTO runtime_leases (name, holder, expires_at) VALUES (?, ?, ?)",
        [name, holder, expiresAt]
      );
      return true;
    }

    if (existing.expires_at < now || existing.holder === holder) {
      db.run(
        "UPDATE runtime_leases SET holder = ?, expires_at = ? WHERE name = ?",
        [holder, expiresAt, name]
      );
      return true;
    }

    return false;
  });
}

/**
 * Release a named lease if owned by holder.
 *
 * @param {string} name - Lease name
 * @param {string} holder - Unique identifier of the holder
 * @returns {Promise<boolean>}
 */
export async function releaseLease(name, holder) {
  const db = await getAdapter();
  const res = db.run(
    "DELETE FROM runtime_leases WHERE name = ? AND holder = ?",
    [name, holder]
  );
  return (res.changes ?? 0) > 0;
}

/**
 * Renew an existing lease held by holder.
 *
 * @param {string} name - Lease name
 * @param {string} holder - Unique identifier of the holder
 * @param {number} [ttlMs=30000] - Additional TTL in milliseconds
 * @returns {Promise<boolean>}
 */
export async function renewLease(name, holder, ttlMs = 30000) {
  const db = await getAdapter();
  const expiresAt = Date.now() + ttlMs;
  const res = db.run(
    "UPDATE runtime_leases SET expires_at = ? WHERE name = ? AND holder = ?",
    [expiresAt, name, holder]
  );
  return (res.changes ?? 0) > 0;
}
