import { describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { hashDashboardPassword, compareDashboardPassword } from "../../src/lib/auth/passwordHash.js";

const oldHash = "$2b$10$Rfs939ZJ53Qv747q6ioaIu9kY7/mP/NQCEhz9TN9QS.bxaGbD/43S";

describe("dashboard bcrypt compatibility", () => {
  it.each(["2a", "2b", "2y"])("accepts legacy %s hashes and rejects wrong passwords", async (prefix) => {
    const hash = oldHash.replace("2b", prefix);
    expect(await compareDashboardPassword("stored-password", hash)).toBe(true);
    expect(await compareDashboardPassword("wrong-password", hash)).toBe(false);
  });

  it.each(["a".repeat(71), "a".repeat(72), "a".repeat(73), "a".repeat(71) + "\u00e9", "nul\0password", "", "\ud800"])(
    "preserves old and new bcrypt semantics for %j", async (password) => {
      const legacy = await bcrypt.hash(password, 10);
      expect(await compareDashboardPassword(password, legacy)).toBe(true);
      const native = await hashDashboardPassword(password);
      expect(await bcrypt.compare(password, native)).toBe(true);
      expect(await compareDashboardPassword(password, native)).toBe(true);
      expect(await compareDashboardPassword("wrong-password", native)).toBe(false);
    },
  );

  it("truncates bytes, including an incomplete UTF-8 sequence", async () => {
    const hash = await hashDashboardPassword("a".repeat(71) + "\u00e9");
    expect(await compareDashboardPassword("a".repeat(71) + "\u00ea", hash)).toBe(true);
    expect(await bcrypt.compare("a".repeat(71) + "\u00ea", hash)).toBe(true);
    const full = await hashDashboardPassword("a".repeat(72) + "first");
    expect(await compareDashboardPassword("a".repeat(72) + "second", full)).toBe(true);
  });

  it.each(["not-a-hash", "$2b$10$short", "$argon2id$v=19$bad"])("retains legacy malformed hash behavior for %s", async (hash) => {
    expect(await compareDashboardPassword("stored-password", hash)).toBe(await bcrypt.compare("stored-password", hash));
  });

  it("retains legacy argument validation", async () => {
    await expect(hashDashboardPassword(null)).rejects.toThrow();
    await expect(compareDashboardPassword(null, oldHash)).rejects.toThrow();
  });
});
