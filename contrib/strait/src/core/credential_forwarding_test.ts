import { expect, test } from "bun:test";
import { createServer } from "node:net";
import {
  createMitmCA,
  disposeMitmCA,
} from "../../node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-ca.js";
import { assertCredentialOverwritePatched } from "./selfcheck.ts";

// This exercises the installed srt library and Linux network helpers, without
// Docker, external network, or executing a sandbox. Missing patches fail.
assertCredentialOverwritePatched();
const hasLinuxNetworkHelpers =
  process.platform === "linux" &&
  Boolean(Bun.which("bwrap") && Bun.which("socat"));
const canBindLocalSocket = await new Promise<boolean>((resolve) => {
  const probe = createServer();
  probe.once("error", () => resolve(false));
  probe.listen(0, "127.0.0.1", () => probe.close(() => resolve(true)));
});
test.skipIf(!hasLinuxNetworkHelpers || !canBindLocalSocket)(
  "patched srt manager forwards host-owned auth and byte-identical data",
  async () => {
    const ca = createMitmCA({});
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      child = Bun.spawn(
        [
          process.execPath,
          `${import.meta.dir}/testdata/credential_forwarding.ts`,
        ],
        {
          env: {
            ...process.env,
            TEST_CA_CERT: ca.certPath,
            TEST_CA_KEY: ca.keyPath,
            NODE_EXTRA_CA_CERTS: ca.certPath,
            HTTP_PROXY: "",
            HTTPS_PROXY: "",
            http_proxy: "",
            https_proxy: "",
            ALL_PROXY: "",
            all_proxy: "",
            SRT_DEBUG: "",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      timeout = setTimeout(() => child?.kill(), 15000);
      timeout.unref();
      const [out, err, code] = await Promise.all([
        new Response(child.stdout as ReadableStream).text(),
        new Response(child.stderr as ReadableStream).text(),
        child.exited,
      ]);
      expect({ code, err }).toEqual({ code: 0, err: "" });
      expect(out).toContain("patched manager forwarding:");
    } finally {
      clearTimeout(timeout);
      if (child?.exitCode === null) child.kill();
      await child?.exited;
      await disposeMitmCA(ca);
    }
  },
  20000,
);
