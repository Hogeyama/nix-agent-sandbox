import {
  type ForwardSpec,
  forwardKey,
  type InitialForward,
} from "../../network/port_forward_model.ts";

/** Config is a session seed; internal ownership survives later user removal. */
export function buildInitialForwards(
  configured: readonly ForwardSpec[],
  receiverPort: number | null,
): InitialForward[] {
  const entries = new Map<string, InitialForward>();
  const add = (spec: ForwardSpec, owner: "config" | "internal") => {
    const key = forwardKey(spec);
    const existing = entries.get(key);
    if (existing) {
      if (existing.hostPort !== spec.hostPort)
        throw new Error(`conflicting initial forwarding: ${key}`);
      if (!existing.owners.includes(owner)) existing.owners.push(owner);
    } else entries.set(key, { ...spec, owners: [owner] });
  };
  for (const spec of configured) add(spec, "config");
  if (receiverPort !== null)
    add(
      {
        direction: "remote",
        hostPort: receiverPort,
        containerPort: receiverPort,
      },
      "internal",
    );
  return [...entries.values()];
}
