const exportButton = document.getElementById("export");
const status = document.getElementById("status");
const sameSites = { strict: "Strict", lax: "Lax", no_restriction: "None" };
const cookieName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const controlCharacters = /[\x00-\x1f\x7f]/;
const encoder = new TextEncoder();

function transferableCookie(cookie, nowSeconds) {
  if (cookie.domain !== "chatgpt.com" && cookie.domain !== ".chatgpt.com") return null;
  // Partitioned cookies belong to a top-level-site partition, not this format.
  if (cookie.partitionKey !== undefined) return null;
  if (typeof cookie.name !== "string" || !cookieName.test(cookie.name)) return null;
  if (typeof cookie.value !== "string" || controlCharacters.test(cookie.value)) return null;
  if (encoder.encode(cookie.name + cookie.value).byteLength > 4096) return null;
  if (typeof cookie.path !== "string" || !cookie.path.startsWith("/") || controlCharacters.test(cookie.path)) return null;
  if (typeof cookie.hostOnly !== "boolean" || typeof cookie.session !== "boolean"
    || typeof cookie.httpOnly !== "boolean" || typeof cookie.secure !== "boolean") return null;
  const expires = cookie.session ? -1 : cookie.expirationDate;
  if (!cookie.session && (!Number.isFinite(expires) || expires <= nowSeconds)) return null;
  if (cookie.name.startsWith("__Secure-") && !cookie.secure) return null;
  if (cookie.name.startsWith("__Host-") && (!cookie.secure || !cookie.hostOnly || cookie.path !== "/")) return null;
  if (cookie.sameSite !== "unspecified" && !Object.hasOwn(sameSites, cookie.sameSite)) return null;
  const sameSite = sameSites[cookie.sameSite];
  if (sameSite === "None" && !cookie.secure) return null;
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.hostOnly ? "chatgpt.com" : ".chatgpt.com",
    path: cookie.path,
    expires,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    ...(sameSite ? { sameSite } : {}),
  };
}

exportButton.addEventListener("click", async () => {
  exportButton.disabled = true;
  status.textContent = "Preparing the session file…";
  let objectUrl;
  try {
    const nowSeconds = Date.now() / 1000;
    const cookies = (await chrome.cookies.getAll({ domain: "chatgpt.com" }))
      .map(cookie => transferableCookie(cookie, nowSeconds))
      .filter(cookie => cookie !== null);
    if (cookies.length === 0) {
      status.textContent = "No valid unexpired ChatGPT cookies were found. Sign in to ChatGPT in this Chrome profile, then export again.";
      return;
    }
    const session = { format: "9router-chatgpt-session", version: 1, cookies };
    const blob = new Blob([JSON.stringify(session)], { type: "application/json" });
    objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = "chatgpt-session.json";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    status.textContent = "Session file download started. Import it into your trusted 9Router dashboard, then delete the file. A valid export does not guarantee the server will accept the session.";
  } catch {
    status.textContent = "Could not export the ChatGPT session. Check this extension's ChatGPT site permission and try again.";
  } finally {
    // Let Chromium receive the download before releasing the in-memory blob.
    if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    exportButton.disabled = false;
  }
});
