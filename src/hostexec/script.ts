// @ts-expect-error Bun's text loader supports extensionless executable assets,
// while TypeScript has no declaration syntax for this exact relative module.
import scriptContent from "./hostexec" with { type: "text" };

/** Bare command installed into the hostexec wrapper directory. */
export const HOSTEXEC_SCRIPT_COMMAND = "hostexec";

/** Exact container path used to distinguish the nas-installed command. */
export const HOSTEXEC_SCRIPT_CONTAINER_PATH = "/opt/nas/hostexec/bin/hostexec";

/** Embedded directly from the single canonical executable asset. */
export const HOSTEXEC_SCRIPT_CONTENT = scriptContent;
