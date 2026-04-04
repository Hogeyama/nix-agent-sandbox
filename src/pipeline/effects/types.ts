/** Handle returned by executeEffect for teardown */
export interface ResourceHandle {
  kind: string;
  close(): Promise<void>;
}
