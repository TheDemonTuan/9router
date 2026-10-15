const CANONICAL_BCRYPT = /^\$2[aby]\$(0[4-9]|[12][0-9]|3[01])\$[./A-Za-z0-9]{53}$/;

function nativeInput(password) {
  return typeof password === "string" && password.length > 0 && password.isWellFormed();
}

export async function hashDashboardPassword(password) {
  if (!nativeInput(password)) {
    const { default: bcrypt } = await import("bcryptjs");
    return bcrypt.hash(password, 10);
  }
  return Bun.password.hash(Buffer.from(password, "utf8").subarray(0, 72), {
    algorithm: "bcrypt",
    cost: 10,
  });
}

export async function compareDashboardPassword(password, storedHash) {
  if (!nativeInput(password) || typeof storedHash !== "string" || !CANONICAL_BCRYPT.test(storedHash)) {
    const { default: bcrypt } = await import("bcryptjs");
    return bcrypt.compare(password, storedHash);
  }
  return Bun.password.verify(Buffer.from(password, "utf8").subarray(0, 72), storedHash);
}
