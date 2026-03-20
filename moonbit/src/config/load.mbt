///| Error type for config loading.
pub(all) suberror ConfigError {
  ConfigError(String)
} derive(Show)

///| Load configuration from .agent-sandbox.nix file.
/// Searches upward from the given directory.
pub fn load_config(start_dir : String) -> Config raise ConfigError {
  let config_path = find_config(start_dir)
  match config_path {
    None => raise ConfigError("No .agent-sandbox.nix found")
    Some(path) => load_nix_config(path)
  }
}

///| Search upward from start_dir for .agent-sandbox.nix.
fn find_config(start_dir : String) -> String? {
  let mut dir = start_dir
  while true {
    let candidate = dir + "/.agent-sandbox.nix"
    if @fs.path_exists(candidate) {
      return Some(candidate)
    }
    let parent = dirname(dir)
    if parent == dir {
      return None
    }
    dir = parent
  }
  None
}

///| Get parent directory (simple implementation).
fn dirname(path : String) -> String {
  let mut last_slash = -1
  for i = 0; i < path.length(); i = i + 1 {
    if path[i] == '/' {
      last_slash = i
    }
  }
  if last_slash <= 0 {
    "/"
  } else {
    path[0:last_slash].to_string()
  }
}

///| Load config from a .nix file by evaluating it with nix.
fn load_nix_config(path : String) -> Config raise ConfigError {
  let json_str = @process.capture_output(
    "nix eval --impure --json --file " + shell_escape(path),
  )
  if json_str.length() == 0 {
    raise ConfigError("nix eval returned empty output for " + path)
  }
  parse_config_json(json_str)
}

///| Parse the JSON output from nix eval into a Config.
fn parse_config_json(json_str : String) -> Config raise ConfigError {
  let json : Json = try {
    @json.parse(json_str)
  } catch {
    e => raise ConfigError("JSON parse error: " + e.to_string())
  }
  match json {
    Json::Object(obj) => {
      let default_ : String? = match obj.get("default") {
        Some(Json::String(s)) => Some(s)
        _ => None
      }
      let profiles : Map[String, Profile] = {}
      match obj.get("profiles") {
        Some(Json::Object(prof_obj)) =>
          prof_obj.each(
            fn(name, val) {
              let p = parse_profile_safe(val)
              match p {
                Some(prof) => profiles.set(name, prof)
                None => ()
              }
            },
          )
        _ => ()
      }
      { default_, profiles }
    }
    _ => raise ConfigError("Config JSON is not an object")
  }
}

///| Parse a profile, returning None on failure.
fn parse_profile_safe(json : Json) -> Profile? {
  match json {
    Json::Object(obj) => {
      let agent : AgentType = match obj.get("agent") {
        Some(Json::String("claude")) => Claude
        Some(Json::String("copilot")) => Copilot
        Some(Json::String("codex")) => Codex
        _ => Claude
      }
      let agent_args : Array[String] = match obj.get("agent-args") {
        Some(Json::Array(arr)) =>
          arr
          .iter()
          .filter_map(
            fn(v) {
              match v {
                Json::String(s) => Some(s)
                _ => None
              }
            },
          )
          .collect()
        _ => []
      }
      let nix : NixConfig = match obj.get("nix") {
        Some(Json::Object(nix_obj)) => {
          let enable = match nix_obj.get("enable") {
            Some(Json::True) => true
            _ => false
          }
          let mount_socket = match nix_obj.get("mount-socket") {
            Some(Json::True) => true
            _ => false
          }
          { enable, mount_socket, extra_packages: [] }
        }
        _ => NixConfig::default_()
      }
      let docker : DockerConfig = match obj.get("docker") {
        Some(Json::Object(d_obj)) => {
          let enable = match d_obj.get("enable") {
            Some(Json::True) => true
            _ => false
          }
          { enable, }
        }
        _ => DockerConfig::default_()
      }
      let network : NetworkConfig = match obj.get("network") {
        Some(Json::Object(n_obj)) => {
          let allowlist : Array[String] = match n_obj.get("allowlist") {
            Some(Json::Array(arr)) =>
              arr
              .iter()
              .filter_map(
                fn(v) {
                  match v {
                    Json::String(s) => Some(s)
                    _ => None
                  }
                },
              )
              .collect()
            _ => []
          }
          { allowlist, }
        }
        _ => NetworkConfig::default_()
      }
      let env : Array[EnvEntry] = match obj.get("env") {
        Some(Json::Array(arr)) =>
          arr
          .iter()
          .filter_map(
            fn(v) {
              match v {
                Json::Object(e_obj) =>
                  match e_obj.get("key") {
                    Some(Json::String(key)) => {
                      let val : String = match e_obj.get("val") {
                        Some(Json::String(v)) => v
                        _ => ""
                      }
                      Some({ key, val })
                    }
                    _ => None
                  }
                _ => None
              }
            },
          )
          .collect()
        _ => []
      }
      Some({
        agent,
        agent_args,
        nix,
        docker,
        network,
        extra_mounts: [],
        env,
      })
    }
    _ => None
  }
}

///| Simple shell escaping (wraps in single quotes).
fn shell_escape(s : String) -> String {
  "'" + s + "'"
}
