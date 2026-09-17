import { Layer } from "effect";
import { DockerServiceLive } from "../services/docker.ts";
import { FsServiceLive } from "../services/fs.ts";
import { ProcessServiceLive } from "../services/process.ts";
import {
  makeSecretResolverService,
  SecretResolverService,
} from "../services/secret_resolver.ts";
import { DbusProxyServiceLive } from "../stages/dbus_proxy.ts";
import { DindServiceLive } from "../stages/dind.ts";
import { DisplayServiceLive } from "../stages/display.ts";
import { DockerBuildServiceLive } from "../stages/docker_build.ts";
import { GuideServiceLive } from "../stages/guide.ts";
import {
  HostExecBrokerServiceLive,
  HostExecSetupServiceLive,
} from "../stages/hostexec.ts";
import { ContainerLaunchServiceLive } from "../stages/launch.ts";
import { MaskFilterServiceLive, MaskFsServiceLive } from "../stages/maskfs.ts";
import { MountSetupServiceLive } from "../stages/mount.ts";
import { OtlpReceiverServiceLive } from "../stages/observability.ts";
import { PortBindServiceLive } from "../stages/port_bind.ts";
import {
  CaServiceLive,
  NetworkRuntimeServiceLive,
  ProxyServiceLive,
  SessionBrokerServiceLive,
} from "../stages/proxy.ts";
import { SessionStoreServiceLive } from "../stages/session_store.ts";
import {
  GitWorktreeServiceLive,
  PromptServiceLive,
} from "../stages/worktree.ts";

/** Live services shared by terminal and Dev Container preparation pipelines. */
export function createPipelineLiveLayer() {
  const primitiveLayer = Layer.mergeAll(FsServiceLive, ProcessServiceLive);
  const secretResolverLayer = Layer.succeed(
    SecretResolverService,
    makeSecretResolverService(),
  );
  const hostServiceLayer = Layer.mergeAll(
    FsServiceLive,
    ProcessServiceLive,
    secretResolverLayer,
  );
  const dockerLayer = DockerServiceLive;
  return Layer.mergeAll(
    ContainerLaunchServiceLive.pipe(Layer.provide(dockerLayer)),
    DbusProxyServiceLive.pipe(Layer.provide(primitiveLayer)),
    DindServiceLive,
    DisplayServiceLive.pipe(Layer.provide(primitiveLayer)),
    DockerBuildServiceLive.pipe(
      Layer.provide(Layer.merge(FsServiceLive, dockerLayer)),
    ),
    CaServiceLive.pipe(Layer.provide(Layer.merge(FsServiceLive, dockerLayer))),
    ProxyServiceLive.pipe(Layer.provide(dockerLayer)),
    FsServiceLive,
    GitWorktreeServiceLive.pipe(Layer.provide(primitiveLayer)),
    GuideServiceLive.pipe(Layer.provide(FsServiceLive)),
    HostExecBrokerServiceLive,
    HostExecSetupServiceLive.pipe(Layer.provide(FsServiceLive)),
    MaskFilterServiceLive.pipe(Layer.provide(hostServiceLayer)),
    MaskFsServiceLive.pipe(Layer.provide(hostServiceLayer)),
    MountSetupServiceLive.pipe(Layer.provide(FsServiceLive)),
    NetworkRuntimeServiceLive.pipe(Layer.provide(hostServiceLayer)),
    OtlpReceiverServiceLive,
    PortBindServiceLive.pipe(Layer.provide(dockerLayer)),
    ProcessServiceLive,
    DockerServiceLive,
    PromptServiceLive,
    SessionBrokerServiceLive,
    SessionStoreServiceLive,
  );
}
