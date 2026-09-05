import { describe, expect, test } from "bun:test";
import { GUIDE_SKILL_NAME, renderGuide } from "./content.ts";
import type { GuideFacts } from "./facts.ts";

function makeFacts(overrides: Partial<GuideFacts> = {}): GuideFacts {
  return {
    agent: "claude",
    workDir: "/work/repo",
    network: { fallback: "deny", pendingTimeoutSeconds: 300, forwardPorts: [] },
    hostexec: null,
    dind: null,
    maskEnabled: false,
    displaySandbox: "none",
    extra: null,
    ...overrides,
  };
}

function parseFrontmatter(out: string): unknown {
  const lines = out.split("\n");
  const end = lines.indexOf("---", 1);
  const block = lines.slice(0, end + 1).join("\n");
  const parsed = Bun.YAML.parse(block);
  // A leading and trailing "---" makes this a two-document YAML stream (the
  // mapping, then an empty document for the closing marker) rather than a
  // single document, so Bun.YAML.parse returns an array — take the mapping.
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

describe("renderGuide", () => {
  test("emits frontmatter with the skill name and a description", () => {
    const out = renderGuide(makeFacts());
    const lines = out.split("\n");

    expect(lines[0]).toBe("---");
    expect(out).toContain(`name: ${GUIDE_SKILL_NAME}`);
    expect(out).toMatch(/^description: .+$/m);
    expect(lines.indexOf("---", 1)).toBeGreaterThan(1);
  });

  test("emits frontmatter that parses as YAML with the exact description", () => {
    const out = renderGuide(
      makeFacts({
        hostexec: { promptEnabled: true, timeoutSeconds: 300 },
        dind: { shared: false },
      }),
    );

    const parsed = parseFrontmatter(out) as {
      name: string;
      description: string;
    };
    expect(parsed.name).toBe(GUIDE_SKILL_NAME);
    expect(parsed.description).toBe(
      "Read before retrying or working around an unexpected failure inside " +
        "the nas sandbox: network requests fail to resolve or are refused; " +
        "a command becomes unresponsive for minutes; a docker build fails " +
        "to reach the network. Explains which sandbox constraint causes " +
        "each, and which ones no amount of retrying will get past.",
    );
  });

  test("always states the workspace boundary", () => {
    expect(renderGuide(makeFacts())).toContain("/work/repo");
  });

  test("says denied domains fail immediately when fallback is deny", () => {
    const out = renderGuide(
      makeFacts({
        network: {
          fallback: "deny",
          pendingTimeoutSeconds: 300,
          forwardPorts: [],
        },
      }),
    );

    expect(out).toContain("retry");
    expect(out).not.toContain("waits for approval");
  });

  test("says denied domains block for approval when fallback is review", () => {
    const out = renderGuide(
      makeFacts({
        network: {
          fallback: "review",
          pendingTimeoutSeconds: 120,
          forwardPorts: [],
        },
      }),
    );

    expect(out).toContain("waits for approval");
    expect(out).toContain("120");
  });

  test("lists forwarded ports only when there are any", () => {
    expect(renderGuide(makeFacts())).not.toContain("Forwarded ports");

    const out = renderGuide(
      makeFacts({
        network: {
          fallback: "deny",
          pendingTimeoutSeconds: 300,
          forwardPorts: [8080, 5432],
        },
      }),
    );
    expect(out).toContain("Forwarded ports");
    expect(out).toContain("8080");
    expect(out).toContain("5432");
  });

  test("states the localhost:<port> form for forwarded ports", () => {
    const out = renderGuide(
      makeFacts({
        network: {
          fallback: "deny",
          pendingTimeoutSeconds: 300,
          forwardPorts: [8080, 5432],
        },
      }),
    );
    expect(out).toContain("localhost:<port>");
  });

  test("description carries a ports symptom only when forwardPorts is non-empty", () => {
    const bare = renderGuide(makeFacts());
    const bareDescription =
      bare.split("\n").find((l) => l.startsWith("description:")) ?? "";
    expect(bareDescription).not.toContain("host port is refused");

    const withPorts = renderGuide(
      makeFacts({
        network: {
          fallback: "deny",
          pendingTimeoutSeconds: 300,
          forwardPorts: [8080],
        },
      }),
    );
    const withPortsDescription =
      withPorts.split("\n").find((l) => l.startsWith("description:")) ?? "";
    expect(withPortsDescription).toContain("host port is refused");
  });

  test("warns that a hostexec approval is not a hang, with the timeout", () => {
    expect(renderGuide(makeFacts())).not.toContain("host");

    const out = renderGuide(
      makeFacts({ hostexec: { promptEnabled: true, timeoutSeconds: 300 } }),
    );
    expect(out).toContain("300");
    expect(out).toContain("not a hang");
  });

  test("explains the DinD build asymmetry only when docker is enabled", () => {
    expect(renderGuide(makeFacts())).not.toContain("apt-get");

    const out = renderGuide(makeFacts({ dind: { shared: true } }));
    expect(out).toContain("apt-get");
  });

  test("mentions masking only when mask is configured", () => {
    expect(renderGuide(makeFacts())).not.toContain("masked");
    expect(renderGuide(makeFacts({ maskEnabled: true }))).toContain("masked");
  });

  test("mentions the display sandbox only when it is not none", () => {
    expect(renderGuide(makeFacts())).not.toContain("xpra");
    expect(renderGuide(makeFacts({ displaySandbox: "xpra" }))).toContain(
      "xpra",
    );
  });

  test("appends the user's extra section verbatim", () => {
    const out = renderGuide(
      makeFacts({ extra: "Run `just fmt` before committing." }),
    );

    expect(out).toContain("Run `just fmt` before committing.");
    expect(out.trimEnd().endsWith("Run `just fmt` before committing.")).toBe(
      true,
    );
  });

  test("description names only the symptoms of enabled features", () => {
    const bare = renderGuide(makeFacts());
    const bareDescription =
      bare.split("\n").find((l) => l.startsWith("description:")) ?? "";
    expect(bareDescription).not.toContain("docker");
    expect(bareDescription).not.toContain("unresponsive");

    const full = renderGuide(
      makeFacts({
        hostexec: { promptEnabled: true, timeoutSeconds: 300 },
        dind: { shared: false },
      }),
    );
    const fullDescription =
      full.split("\n").find((l) => l.startsWith("description:")) ?? "";
    expect(fullDescription).toContain("docker");
    expect(fullDescription).toContain("unresponsive");
  });

  test("description does not claim unresponsiveness when hostexec never prompts", () => {
    const out = renderGuide(
      makeFacts({ hostexec: { promptEnabled: false, timeoutSeconds: 300 } }),
    );
    const parsed = parseFrontmatter(out) as { description: string };
    expect(parsed.description).not.toContain("unresponsive");
  });

  test("description claims unresponsiveness when network fallback is review, stated once even with hostexec prompting also enabled", () => {
    const reviewOnly = renderGuide(
      makeFacts({
        network: {
          fallback: "review",
          pendingTimeoutSeconds: 120,
          forwardPorts: [],
        },
      }),
    );
    const reviewOnlyDescription = (
      parseFrontmatter(reviewOnly) as { description: string }
    ).description;
    expect(reviewOnlyDescription).toContain("unresponsive");

    const both = renderGuide(
      makeFacts({
        network: {
          fallback: "review",
          pendingTimeoutSeconds: 120,
          forwardPorts: [],
        },
        hostexec: { promptEnabled: true, timeoutSeconds: 300 },
      }),
    );
    const bothDescription = (parseFrontmatter(both) as { description: string })
      .description;
    const occurrences = bothDescription.split("unresponsive").length - 1;
    expect(occurrences).toBe(1);
  });

  test("omits the extra section when extra is empty or whitespace-only", () => {
    expect(renderGuide(makeFacts({ extra: "" }))).not.toContain(
      "Notes for this environment",
    );
    expect(renderGuide(makeFacts({ extra: "   " }))).not.toContain(
      "Notes for this environment",
    );
  });
});
