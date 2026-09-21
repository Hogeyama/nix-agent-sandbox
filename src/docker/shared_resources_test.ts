import { expect, test } from "bun:test";
import { sharedDockerResources } from "./shared_resources.ts";

test("shared resources preserve production names without a namespace", () => {
  expect(sharedDockerResources({})).toEqual({
    proxyContainer: "nas-proxy-shared",
    sandboxImage: "nas-sandbox",
  });
});

test("separate runs cannot recreate each other's shared proxy or image", () => {
  const first = sharedDockerResources({ NAS_RESOURCE_NAMESPACE: "test-first" });
  const second = sharedDockerResources({
    NAS_RESOURCE_NAMESPACE: "test-second",
  });
  expect(first.proxyContainer).toBe("nas-proxy-test-first");
  expect(first.sandboxImage).toBe("nas-sandbox-test-first");
  expect(first.proxyContainer).not.toBe(second.proxyContainer);
  expect(first.sandboxImage).not.toBe(second.sandboxImage);
  expect(() =>
    sharedDockerResources({ NAS_RESOURCE_NAMESPACE: "bad/name" }),
  ).toThrow();
});
