import { strict as assert } from "node:assert";
import { createHash, createPublicKey } from "node:crypto";
import { closeSync, fchmodSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";

interface TransferCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}
interface TransferSession {
  format: "9router-chatgpt-session";
  version: 1;
  cookies: TransferCookie[];
}

const options = new Map<string, string>();
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  const name = args[index];
  const value = args[index + 1];
  if ((name !== "--extension-dir" && name !== "--output") || !value || options.has(name)) {
    throw new Error("Usage: session-export-smoke.ts --extension-dir <absolute path> --output <private synthetic JSON path>");
  }
  options.set(name, value);
}
const extensionDir = options.get("--extension-dir");
const output = options.get("--output");
if (!extensionDir || !output || !isAbsolute(extensionDir) || !isAbsolute(output)) {
  throw new Error("Both --extension-dir and --output must be absolute paths");
}
const manifest = JSON.parse(readFileSync(join(extensionDir, "manifest.json"), "utf8"));
assert.equal(manifest.manifest_version, 3);
assert.deepEqual([...manifest.permissions].sort(), ["activeTab", "cookies", "scripting"]);
assert.deepEqual(manifest.host_permissions, ["https://chatgpt.com/*"]);
assert.equal(typeof manifest.action?.default_popup, "string");
assert.equal(manifest.background?.type, "module");
assert.equal(typeof manifest.background?.service_worker, "string");
assert.equal(manifest.commands?._execute_action?.suggested_key?.default, "Alt+Shift+9");
assert(manifest.content_security_policy.extension_pages.includes("connect-src 'none'"));
for (const field of ["content_scripts", "externally_connectable", "web_accessible_resources", "optional_permissions", "optional_host_permissions"]) {
  assert.equal(manifest[field], undefined, `Unexpected extension capability: ${field}`);
}
assert.equal(typeof manifest.key, "string");
const publicKey = Buffer.from(manifest.key, "base64");
assert.equal(createPublicKey({ key: publicKey, type: "spki", format: "der" }).asymmetricKeyType, "rsa");
const extensionId = Array.from(createHash("sha256").update(publicKey).digest().subarray(0, 16))
  .map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join("");
const extensionOrigin = `chrome-extension://${extensionId}`;
const temporary = mkdtempSync(join(tmpdir(), "cgw-session-export-"));
let context: BrowserContext | undefined;

function assertSession(value: unknown): asserts value is TransferSession {
  assert(value && typeof value === "object" && !Array.isArray(value), "Export must be a session envelope");
  const session = value as TransferSession;
  assert.deepEqual(Object.keys(session).sort(), ["cookies", "format", "version"]);
  assert.equal(session.format, "9router-chatgpt-session");
  assert.equal(session.version, 1);
  assert(Array.isArray(session.cookies) && session.cookies.length > 0);
  const unique = new Set<string>();
  for (const cookie of session.cookies) {
    const keys = ["domain", "expires", "httpOnly", "name", "path", "secure", "value"];
    if (Object.hasOwn(cookie, "sameSite")) keys.push("sameSite");
    assert.deepEqual(Object.keys(cookie).sort(), keys.sort(), "Only transferable cookie fields may be exported");
    assert.equal(typeof cookie.name, "string");
    assert(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name));
    assert.equal(typeof cookie.value, "string");
    assert(!/[\x00-\x1f\x7f]/.test(cookie.value));
    assert(Buffer.byteLength(cookie.name + cookie.value, "utf8") <= 4096);
    assert(cookie.domain === "chatgpt.com" || cookie.domain === ".chatgpt.com");
    assert.equal(typeof cookie.path, "string");
    assert(cookie.path.startsWith("/") && !/[\x00-\x1f\x7f]/.test(cookie.path));
    assert(Number.isFinite(cookie.expires) && (cookie.expires === -1 || cookie.expires > Date.now() / 1000));
    assert.equal(typeof cookie.httpOnly, "boolean");
    assert.equal(typeof cookie.secure, "boolean");
    if (Object.hasOwn(cookie, "sameSite")) assert(["Strict", "Lax", "None"].includes(cookie.sameSite!));
    if (cookie.sameSite === "None" || cookie.name.startsWith("__Secure-")) assert(cookie.secure);
    if (cookie.name.startsWith("__Host-")) assert(cookie.secure && cookie.domain === "chatgpt.com" && cookie.path === "/");
    const identity = JSON.stringify([cookie.domain, cookie.path, cookie.name]);
    assert(!unique.has(identity), "Duplicate exported cookie");
    unique.add(identity);
  }
}

async function downloadSession(page: Page, name: string): Promise<TransferSession> {
  const downloading = page.waitForEvent("download", { timeout: 15000 });
  await page.getByRole("button", { name: "Export ChatGPT Session", exact: true }).click();
  const download = await downloading;
  assert.equal(download.suggestedFilename(), "chatgpt-session.json");
  assert.equal(await download.failure(), null, "Extension download must complete");
  const path = join(temporary, name);
  await download.saveAs(path);
  const session: unknown = JSON.parse(readFileSync(path, "utf8"));
  assertSession(session);
  return session;
}

try {
  // Use Playwright's bundled full Chromium: branded Chrome no longer supports
  // side-loading via these flags. Never substitute the production snapshot.
  context = await chromium.launchPersistentContext(join(temporary, "profile"), {
    channel: "chromium",
    headless: true,
    chromiumSandbox: true,
    acceptDownloads: true,
    serviceWorkers: "allow",
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      "--host-resolver-rules=MAP * ~NOTFOUND",
    ],
  });
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    return url.protocol === "chrome-extension:" && url.hostname === extensionId ? route.continue() : route.abort();
  });
  await context.routeWebSocket("**/*", socket => socket.close());
  const page = await context.newPage();
  await page.goto(`${extensionOrigin}/${manifest.action.default_popup}`);
  let downloads = 0;
  page.on("download", () => { downloads += 1; });
  await page.getByRole("button", { name: "Export ChatGPT Session", exact: true }).click();
  await page.getByRole("status").getByText(/No valid unexpired ChatGPT cookies/).waitFor();
  assert.equal(downloads, 0, "Empty cookie store must not produce a session file");

  const expires = Math.floor(Date.now() / 1000) + 3600;
  const fixtures = [
    { name: "cgw_fixture_session.0", value: "offline-account", domain: "chatgpt.com", path: "/", expires, httpOnly: true, secure: true, sameSite: "Lax" as const },
    { name: "cgw_fixture_session.1", value: "-import", domain: "chatgpt.com", path: "/", expires, httpOnly: true, secure: true, sameSite: "Strict" as const },
  ];
  const google = { name: "cgw_fixture_google", value: "not-exported", domain: ".google.com", path: "/", expires, httpOnly: true, secure: true, sameSite: "Lax" as const };
  await context.addCookies([
    ...fixtures,
    google,
    { name: "cgw_fixture_session_only", value: "session", domain: ".chatgpt.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "None" },
    { name: "cgw_fixture_path", value: "path", domain: ".chatgpt.com", path: "/settings", expires, httpOnly: false, secure: true, sameSite: "Strict" },
    { name: "cgw_fixture_subdomain", value: "not-exported", domain: "sub.chatgpt.com", path: "/", expires, httpOnly: true, secure: true, sameSite: "Lax" },
    { name: "cgw_fixture_partitioned", value: "not-exported", domain: "chatgpt.com", path: "/", expires, httpOnly: true, secure: true, sameSite: "None", partitionKey: "https://example.com" },
    { name: "cgw_fixture_expired", value: "not-exported", domain: "chatgpt.com", path: "/", expires: Math.floor(Date.now() / 1000) - 60, httpOnly: true, secure: true, sameSite: "Lax" },
  ]);
  // Exercise Chrome's actual unspecified SameSite representation, not a mock.
  await page.evaluate(async () => {
    const cookies = Reflect.get(globalThis, "chrome").cookies;
    await cookies.set({ url: "https://chatgpt.com/", name: "cgw_fixture_unspecified", value: "unspecified", secure: true, httpOnly: true });
    const present = await cookies.getAll({ domain: "chatgpt.com" });
    const partitioned = await cookies.getAll({ domain: "chatgpt.com", partitionKey: { topLevelSite: "https://example.com" } });
    if (!partitioned.some((cookie: { name: string; partitionKey?: unknown }) => cookie.name === "cgw_fixture_partitioned" && cookie.partitionKey !== undefined)) {
      throw new Error("Partitioned fixture must be present before export");
    }
    if (!present.some((cookie: { name: string; sameSite: string }) => cookie.name === "cgw_fixture_unspecified" && cookie.sameSite === "unspecified")) {
      throw new Error("Unspecified SameSite fixture must be present before export");
    }
  });
  assert((await context.cookies()).some(cookie => cookie.name === google.name), "Fake Google cookie must be seeded");
  const mapping = await downloadSession(page, "mapping.json");
  assert.deepEqual(mapping.cookies.map(cookie => cookie.name).sort(), [
    "cgw_fixture_path", "cgw_fixture_session.0", "cgw_fixture_session.1", "cgw_fixture_session_only", "cgw_fixture_unspecified",
  ]);
  for (const fixture of fixtures) assert.deepEqual(mapping.cookies.find(cookie => cookie.name === fixture.name), fixture);
  assert.deepEqual(mapping.cookies.find(cookie => cookie.name === "cgw_fixture_session_only"), {
    name: "cgw_fixture_session_only", value: "session", domain: ".chatgpt.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "None",
  });
  assert.deepEqual(mapping.cookies.find(cookie => cookie.name === "cgw_fixture_path"), {
    name: "cgw_fixture_path", value: "path", domain: ".chatgpt.com", path: "/settings", expires, httpOnly: false, secure: true, sameSite: "Strict",
  });
  assert.deepEqual(mapping.cookies.find(cookie => cookie.name === "cgw_fixture_unspecified"), {
    name: "cgw_fixture_unspecified", value: "unspecified", domain: "chatgpt.com", path: "/", expires: -1, httpOnly: true, secure: true,
  });

  // The onboarding input is deliberately restricted to these two synthetic
  // session parts; the source output must never contain real account data.
  await context.clearCookies();
  await context.addCookies([...fixtures, google]);
  const final = await downloadSession(page, "session.json");
  assert.deepEqual(final.cookies.slice().sort((a, b) => a.name.localeCompare(b.name)), fixtures);
  assert.equal(downloads, 2);
  const descriptor = openSync(output, "wx", 0o600);
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(final)}\n`);
  } finally {
    closeSync(descriptor);
  }
  console.log(JSON.stringify({ event: "cgw_session_export_smoke_passed", cookies: final.cookies.length, downloads, providerRequestsSent: 0 }));
} finally {
  try {
    await context?.close();
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
