import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GET, POST, DELETE } from "../../src/app/api/cli-tools/hermes-settings/route.js";
let directory, home, oldPath;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-native-"));
  home = path.join(directory, ".hermes");
  vi.spyOn(os, "homedir").mockReturnValue(directory);
  oldPath = process.env.PATH;
  process.env.PATH = directory;
});
afterEach(async () => {
  process.env.PATH = oldPath;
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});
const request = body => new Request("http://localhost/api/cli-tools/hermes-settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const installExecutable = async () => {
  const file = path.join(directory, process.platform === "win32" ? "hermes.exe" : "hermes");
  await fs.writeFile(file, "synthetic executable detection fixture");
  await fs.chmod(file, 0o700);
};
it("reports absent installation and detects executable without reading a config", async () => {
  expect((await (await GET()).json()).installed).toBe(false);
  await installExecutable();
  const body = await (await GET()).json();
  expect(body.installed).toBe(true);
  expect(body.settings.model).toBeNull();
});
it("recognizes config-only installations and preserves unowned YAML and env tokens", async () => {
  await fs.mkdir(home);
  await fs.writeFile(path.join(home, "config.yaml"), "# Unicode \u00e9\ncustom_setting: keep\n");
  await fs.writeFile(path.join(home, ".env"), "BOT_TOKEN=synthetic-bot\nOTHER=value\n");
  expect((await (await GET()).json()).installed).toBe(true);
  const response = await POST(request({ baseUrl: "http://127.0.0.1:24127", model: "synthetic-model", apiKey: "synthetic-router-key" }));
  expect(response.status).toBe(200);
  expect(await Bun.file(path.join(home, "config.yaml")).text()).toContain("# Unicode \u00e9\ncustom_setting: keep\n");
  expect(await Bun.file(path.join(home, ".env")).text()).toContain("BOT_TOKEN=synthetic-bot\nOTHER=value\n");
});
it("resets a missing config without creating it", async () => {
  const response = await DELETE(request({}));
  expect((await response.json()).message).toBe("No config file to reset");
  expect(await Bun.file(path.join(home, "config.yaml")).exists()).toBe(false);
});
it("does not recreate a missing named profile", async () => {
  const response = await POST(request({ profile: "gone", baseUrl: "http://127.0.0.1:24127", model: "synthetic-model" }));
  expect(response.status).toBe(404);
  await expect(fs.stat(path.join(home, "profiles", "gone"))).rejects.toMatchObject({ code: "ENOENT" });
});
