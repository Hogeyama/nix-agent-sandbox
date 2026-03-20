///| Execution context passed through the pipeline stages.
pub(all) struct ExecutionContext {
  /// Resolved config
  config : @config.Config
  /// Selected profile
  profile : @config.Profile
  /// Profile name
  profile_name : String
  /// Session ID
  session_id : String
  /// Working directory (container's PWD)
  work_dir : String
  /// Docker image name
  mut image_name : String
  /// Arguments for docker run
  mut docker_args : Array[String]
  /// Environment variables for docker run
  mut env_vars : Map[String, String]
  /// Whether nix is enabled (after auto-detection)
  mut nix_enabled : Bool
  /// Agent launch command
  mut agent_command : Array[String]
} derive(Show)

///| Create a new execution context.
pub fn ExecutionContext::create(
  config : @config.Config,
  profile : @config.Profile,
  profile_name : String,
  work_dir : String
) -> ExecutionContext {
  let session_id = "sess_" + random_hex(6)
  {
    config,
    profile,
    profile_name,
    session_id,
    work_dir,
    image_name: "nas-sandbox",
    docker_args: [],
    env_vars: {},
    nix_enabled: false,
    agent_command: [],
  }
}

///| Generate a simple pseudo-random hex string.
fn random_hex(bytes : Int) -> String {
  let hex = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f']
  let buf = StringBuilder::new()
  for i = 0; i < bytes * 2; i = i + 1 {
    let idx = (i * 7 + 3) % 16
    buf.write_char(hex[idx])
  }
  buf.to_string()
}
