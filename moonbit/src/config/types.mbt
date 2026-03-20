///| Agent type supported by nas.
pub(all) enum AgentType {
  Claude
  Copilot
  Codex
} derive(Show, Eq)

///| Nix configuration.
pub(all) struct NixConfig {
  enable : Bool
  mount_socket : Bool
  extra_packages : Array[String]
} derive(Show)

///| Docker-in-Docker configuration.
pub(all) struct DockerConfig {
  enable : Bool
} derive(Show)

///| Extra mount point.
pub(all) struct ExtraMount {
  src : String
  dst : String
  read_only : Bool
} derive(Show)

///| Environment variable entry.
pub(all) struct EnvEntry {
  key : String
  val : String
} derive(Show)

///| Network configuration (simplified).
pub(all) struct NetworkConfig {
  allowlist : Array[String]
} derive(Show)

///| Profile: a named configuration for running an agent.
pub(all) struct Profile {
  agent : AgentType
  agent_args : Array[String]
  nix : NixConfig
  docker : DockerConfig
  network : NetworkConfig
  extra_mounts : Array[ExtraMount]
  env : Array[EnvEntry]
} derive(Show)

///| Top-level configuration.
pub(all) struct Config {
  default_ : String?
  profiles : Map[String, Profile]
} derive(Show)

///| Create a default NixConfig.
pub fn NixConfig::default_() -> NixConfig {
  { enable: false, mount_socket: false, extra_packages: [] }
}

///| Create a default DockerConfig.
pub fn DockerConfig::default_() -> DockerConfig {
  { enable: false }
}

///| Create a default NetworkConfig.
pub fn NetworkConfig::default_() -> NetworkConfig {
  { allowlist: [] }
}

///| Create a default Profile.
pub fn Profile::default_() -> Profile {
  {
    agent: Claude,
    agent_args: [],
    nix: NixConfig::default_(),
    docker: DockerConfig::default_(),
    network: NetworkConfig::default_(),
    extra_mounts: [],
    env: [],
  }
}
