import { afterEach, describe, expect, test } from "bun:test";
import {
  daemonLogPath,
  daemonStateDir,
  daemonStatePath,
  daemonTokenPath,
} from "./paths.ts";

describe("daemonStateDir", () => {
  const origXdgState = process.env.XDG_STATE_HOME;
  const origHome = process.env.HOME;

  afterEach(() => {
    if (origXdgState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = origXdgState;
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
  });

  test("uses XDG_STATE_HOME when set", () => {
    process.env.XDG_STATE_HOME = "/xdg/state";
    process.env.HOME = "/home/u";
    expect(daemonStateDir()).toBe("/xdg/state/nas/ui");
  });

  test("falls back to HOME/.local/state when XDG_STATE_HOME unset", () => {
    delete process.env.XDG_STATE_HOME;
    process.env.HOME = "/home/u";
    expect(daemonStateDir()).toBe("/home/u/.local/state/nas/ui");
  });

  test("falls back to /tmp/.local/state when neither is set", () => {
    delete process.env.XDG_STATE_HOME;
    delete process.env.HOME;
    expect(daemonStateDir()).toBe("/tmp/.local/state/nas/ui");
  });
});

describe("daemon path helpers", () => {
  const origXdgState = process.env.XDG_STATE_HOME;
  const origHome = process.env.HOME;

  afterEach(() => {
    if (origXdgState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = origXdgState;
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
  });

  test("daemonStatePath / daemonLogPath / daemonTokenPath sit under daemonStateDir", () => {
    process.env.XDG_STATE_HOME = "/xdg/state";
    const dir = daemonStateDir();
    expect(daemonStatePath()).toBe(`${dir}/daemon.json`);
    expect(daemonLogPath()).toBe(`${dir}/daemon.log`);
    expect(daemonTokenPath()).toBe(`${dir}/daemon.token`);
  });
});
