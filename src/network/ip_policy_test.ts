import { expect, test } from "bun:test";
import cases from "./denied_ip_policy_cases.json";
import { isDeniedIpAddress } from "./ip_policy.ts";

for (const { address, denied } of cases) {
  test(`isDeniedIpAddress: ${address} => ${denied}`, () => {
    expect(isDeniedIpAddress(address)).toEqual(denied);
  });
}

test("isDeniedIpAddress: equivalent compressed IPv6 forms", () => {
  expect(isDeniedIpAddress("fc00:0:0:0:0:0:0:1")).toEqual(true);
  expect(isDeniedIpAddress("fe80:0000::1")).toEqual(true);
  expect(isDeniedIpAddress("2001:4860:4860:0:0:0:0:8888")).toEqual(false);
});

test("isDeniedIpAddress: hostnames and malformed values are not numeric", () => {
  expect(isDeniedIpAddress("example.com")).toEqual(false);
  expect(isDeniedIpAddress("1.2.3.999")).toEqual(false);
  expect(isDeniedIpAddress("1::2::3")).toEqual(false);
});
