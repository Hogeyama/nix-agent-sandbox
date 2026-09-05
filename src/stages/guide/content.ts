/**
 * GuideFacts から SKILL.md 全文を組み立てる（純粋）。
 *
 * description は skill 機構によって常時 system prompt に載る。エージェントが
 * 失敗に遭遇した瞬間にガイドの存在へ気づけるかはここに懸かっているので、
 * 有効な機能に対応する症状だけを、症状の語彙で列挙する。
 */

import type { GuideFacts } from "./facts.ts";

export const GUIDE_SKILL_NAME = "nas-sandbox";

function buildDescription(facts: GuideFacts): string {
  const symptoms = ["network requests fail to resolve or are refused"];
  const canHang =
    facts.hostexec?.promptEnabled === true ||
    facts.network.fallback === "review";
  if (canHang) {
    symptoms.push("a command becomes unresponsive for minutes");
  }
  if (facts.dind !== null) {
    symptoms.push("a docker build fails to reach the network");
  }
  if (facts.maskEnabled) {
    symptoms.push("output contains values that look wrong");
  }
  if (facts.network.forwardPorts.length > 0) {
    symptoms.push("a connection to a host port is refused");
  }
  return (
    "Read before retrying or working around an unexpected failure inside " +
    "the nas sandbox: " +
    symptoms.join("; ") +
    ". Explains which sandbox constraint causes each, and which ones no " +
    "amount of retrying will get past."
  );
}

function networkSection(facts: GuideFacts): string {
  const denial =
    facts.network.fallback === "review"
      ? `A request to a domain outside the allowlist waits for approval on the host for up to ${facts.network.pendingTimeoutSeconds} seconds. A timeout means denial, not a transient error.`
      : "A request to a domain outside the allowlist fails immediately, and will fail the same way no matter how many times you retry.";

  return [
    "## Network is an allowlist proxy",
    "",
    denial,
    "",
    "The failure surfaces as a name-resolution error, so it is easy to read as",
    '"this environment has no network". It is not. Other domains work.',
    "",
    "There is no way to widen the allowlist from inside the container. If a",
    "domain you need is blocked, say so and ask the user to add it, rather than",
    "retrying, switching mirrors, or vendoring the dependency.",
  ].join("\n");
}

function forwardedPortsSection(facts: GuideFacts): string {
  const ports = facts.network.forwardPorts.join(", ");
  return [
    "## Forwarded ports",
    "",
    `These host ports are reachable from inside the container, at ` +
      `\`localhost:<port>\` — the same port number, on \`localhost\`, not on ` +
      `a gateway address or \`host.docker.internal\`: ${ports}.`,
    "Any other host port is not.",
  ].join("\n");
}

function hostexecSection(
  hostexec: NonNullable<GuideFacts["hostexec"]>,
): string {
  const approval = hostexec.promptEnabled
    ? `Such a command can sit with no output for up to ${hostexec.timeoutSeconds} seconds while the user decides whether to approve it. **That is not a hang.** Do not kill it, do not retry it in another shell, and do not look for a workaround while it is waiting.`
    : "Such a command runs on the host under a fixed rule set, so its behaviour can differ from the same command run in the container.";

  return ["## Some commands run on the host", "", approval].join("\n");
}

function dindSection(): string {
  return [
    "## Docker builds cannot reach the network",
    "",
    "Docker works here, but a build container has no route out. Pulling a base",
    "image succeeds, because that goes through a proxied daemon, while anything",
    "the build itself fetches — `apt-get`, `pip`, `curl` — fails to resolve.",
    "",
    "So a Dockerfile that pulls fine and then dies on its first `apt-get` is not",
    "a broken Dockerfile. Do not rewrite it; use an image that already carries",
    "what you need, or tell the user the build needs network access.",
  ].join("\n");
}

function maskSection(): string {
  return [
    "## Output is masked",
    "",
    "Secret values are masked out of command output before you see it. A value",
    "that looks truncated or replaced is masked, not corrupt — reading it again",
    "will not reveal more.",
  ].join("\n");
}

function displaySection(facts: GuideFacts): string {
  return [
    "## GUI applications",
    "",
    `Graphical applications run under a ${facts.displaySandbox} display sandbox rather than the host's display.`,
  ].join("\n");
}

export function renderGuide(facts: GuideFacts): string {
  const sections: string[] = [
    [
      "# The nas sandbox",
      "",
      "You are running inside a container managed by nas. Several of its",
      "constraints produce failures that look like ordinary bugs, and reacting to",
      "them as bugs wastes the whole attempt. This page lists those cases.",
      "",
      "## Workspace",
      "",
      `Your workspace is \`${facts.workDir}\`. Paths outside it are either invisible or not persisted.`,
    ].join("\n"),
    networkSection(facts),
  ];

  if (facts.network.forwardPorts.length > 0) {
    sections.push(forwardedPortsSection(facts));
  }
  if (facts.hostexec !== null) {
    sections.push(hostexecSection(facts.hostexec));
  }
  if (facts.dind !== null) {
    sections.push(dindSection());
  }
  if (facts.maskEnabled) {
    sections.push(maskSection());
  }
  if (facts.displaySandbox !== "none") {
    sections.push(displaySection(facts));
  }
  if (facts.extra !== null && facts.extra.trim() !== "") {
    sections.push(
      ["## Notes for this environment", "", facts.extra].join("\n"),
    );
  }

  const frontmatter = [
    "---",
    `name: ${GUIDE_SKILL_NAME}`,
    `description: ${JSON.stringify(buildDescription(facts))}`,
    "---",
  ].join("\n");

  return `${frontmatter}\n\n${sections.join("\n\n")}\n`;
}
