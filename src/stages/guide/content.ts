/**
 * GuideFacts から SKILL.md 全文を組み立てる。
 *
 * description は skill 機構によって常時 system prompt に載る。エージェントが
 * 失敗に遭遇した瞬間にガイドの存在へ気づけるかはここに懸かっているので、
 * 有効な機能に対応する症状と、ブラウザ表示の用途を記載する。
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
  if (facts.network.forwardPorts.length > 0) {
    symptoms.push("a connection to a host port is refused");
  }
  return (
    "Read before retrying or working around an unexpected failure inside " +
    "the nas sandbox: " +
    symptoms.join("; ") +
    ". Explains which sandbox constraint causes each, and which ones no " +
    "amount of retrying will get past. Also read when showing a " +
    "playwright-cli browser to the user via xpra."
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

function visibleBrowserSection(facts: GuideFacts): string {
  const installed = facts.hostexec?.installScript === true;
  const attachInstructions = installed
    ? "When the user needs to see it, run this from nas in a separate terminal\n" +
      "or a retained tool session. hostexec runs the viewer on the host under\n" +
      "the configured approval rules; attach stays running while the viewer is open."
    : "The hostexec command is not enabled. Run this in nas, then give the printed command to the user\n" +
      "to run in a host terminal. It contains the absolute socket path, so the\n" +
      "host terminal does not need nas's environment variables.";
  const attachCommand = installed
    ? 'test -n "$NAS_XPRA_SOCKET" && hostexec xpra attach \\\n' +
      '  --desktop-scaling=off --encoding=rgb --video=no "socket://$NAS_XPRA_SOCKET"'
    : "test -n \"$NAS_XPRA_SOCKET\" && printf 'xpra attach --desktop-scaling=off --encoding=rgb --video=no %q\\n' \\\n" +
      '  "socket://$NAS_XPRA_SOCKET"';
  return [
    "## Show a playwright-cli browser to the user",
    "",
    "Use xpra to let the user watch the same browser you control. This needs",
    "xpra on both sides, and Xvfb and playwright-cli in nas. Run from a workspace",
    "directory visible at the same absolute path on both sides, so the host",
    "can reach the socket. Keep that directory and the variables below across commands.",
    "",
    "In nas, start a separate display when needed. Use an unused display number",
    "(:100 below); if occupied, change it in every command. Use a fresh browser",
    "session name (`visible` below), and reuse it throughout.",
    "",
    "```bash",
    'NAS_XPRA_DIR="$PWD/.playwright-cli/xpra/$NAS_SESSION_ID"',
    'mkdir -p "$NAS_XPRA_DIR"',
    'xpra start :100 --socket-dir="$NAS_XPRA_DIR" --daemon=yes \\',
    "  --xvfb='Xvfb +extension Composite -screen 0 1600x1000x24+32 -nolisten tcp -noreset' \\",
    "  --notifications=no --pulseaudio=no --printing=no --webcam=no \\",
    "  --mdns=no --start-new-commands=no --bell=no --speaker=no --microphone=no",
    'xpra list --socket-dir="$NAS_XPRA_DIR"',
    "DISPLAY=:100 playwright-cli -s=visible open about:blank --headed",
    "playwright-cli -s=visible snapshot",
    "```",
    "",
    "`xpra attach` opens a viewer on the host, connecting to the xpra server's",
    "socket to display the same browser already running in nas.",
    attachInstructions,
    "Continue browser operations with `playwright-cli -s=visible ...`.",
    "",
    "```bash",
    'NAS_XPRA_DIR="$PWD/.playwright-cli/xpra/$NAS_SESSION_ID"',
    'NAS_XPRA_SOCKET="$(find "$NAS_XPRA_DIR" -maxdepth 1 -type s -name \'*-100\' -print -quit)"',
    attachCommand,
    "```",
    "",
    "Disconnect the viewer with Ctrl-C in the attach terminal or tool session.",
    "The browser and server keep running after disconnection. When finished,",
    "close the browser and stop the server in nas. Remove the session directory",
    "only after confirming that the server stopped.",
    "",
    "```bash",
    'NAS_XPRA_DIR="$PWD/.playwright-cli/xpra/$NAS_SESSION_ID"',
    "playwright-cli -s=visible close",
    'xpra stop :100 --socket-dir="$NAS_XPRA_DIR"',
    'xpra list --socket-dir="$NAS_XPRA_DIR"',
    "```",
  ].join("\n");
}

export function renderGuide(facts: GuideFacts): string {
  const sections: string[] = [
    [
      "# The nas sandbox",
      "",
      "You are running inside a container managed by nas. Several of its",
      "constraints produce failures that look like ordinary bugs, and reacting to",
      "them as bugs wastes the whole attempt. This page lists those cases and",
      "explains how to show a browser to the user.",
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
  sections.push(visibleBrowserSection(facts));
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
