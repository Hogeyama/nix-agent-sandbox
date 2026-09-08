async (page) => {
  const out = "docs-site/public/images/";
  await page.setViewportSize({ width: 1440, height: 1240 });
  await page.goto("http://localhost:3939/#/");
  await page.getByText("web-preview", { exact: true }).first().click();
  await page.locator("section.port-bindings-panel").waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: out + "ui-workspace.png" });
  await page
    .locator("section.port-bindings-panel")
    .screenshot({ path: out + "ui-port-bind.png" });
  await page
    .locator('[data-pending-key^="network|"]')
    .screenshot({ path: out + "ui-network-approval.png" });
  await page
    .locator('[data-pending-key^="hostexec|"]')
    .screenshot({ path: out + "ui-hostexec-approval.png" });
  await page.getByRole("button", { name: "+ new session" }).click();
  await page.getByRole("button", { name: "Launch", exact: true }).waitFor();
  await page
    .locator('[role="dialog"]')
    .screenshot({ path: out + "ui-new-session.png" });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 460 });
  await page.goto("http://localhost:3939/#/settings/audit");
  await page.getByRole("heading", { name: "Audit", exact: true }).waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: out + "ui-audit.png" });
  await page.goto("http://localhost:3939/#/history");
  await page.locator(".history-list-row").waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: out + "ui-history.png" });
}
