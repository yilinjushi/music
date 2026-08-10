import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectFile = (path: string) => resolve(process.cwd(), path);

const routerSource = readFileSync(projectFile("src/router.tsx"), "utf8");
const settingsPageSource = readFileSync(
  projectFile("src/components/SettingsPage.tsx"),
  "utf8"
);

describe("settings loading boundary", () => {
  it("loads the settings route eagerly but keeps below-fold settings lazy", () => {
    expect(routerSource).toContain(
      'import { SettingsRoute } from "@/routes/SettingsRoute";'
    );
    expect(routerSource).toContain("element: <SettingsRoute />");
    expect(routerSource).not.toContain('import("@/routes/SettingsRoute")');
    expect(routerSource).not.toContain("lazyRoute(SettingsRoute)");

    expect(settingsPageSource).toContain(
      'import("./settings/SettingsDeferredContent")'
    );
    expect(settingsPageSource).not.toContain(
      'from "./settings/SettingsDeferredContent"'
    );
  });
});
