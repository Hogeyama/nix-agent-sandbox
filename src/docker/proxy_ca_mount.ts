export const PROXY_CA_MOUNT_DIR = "/etc/nas-ca";

export interface ProxyCaCertMount {
  readonly source: string;
  readonly target: string;
  readonly mode: "ro";
  readonly type: "bind";
}

export function proxyCaCertMount(caCertPath: string): ProxyCaCertMount {
  return {
    source: caCertPath,
    target: `${PROXY_CA_MOUNT_DIR}/nas-proxy.crt`,
    mode: "ro",
    type: "bind",
  };
}
