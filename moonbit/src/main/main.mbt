fn main {
  let args = @sys.get_cli_args()

  // Parse CLI arguments
  let mut profile_name : String? = None
  let agent_extra_args : Array[String] = []
  let mut quiet = false
  let mut show_help = false
  let mut after_separator = false

  for i = 0; i < args.length(); i = i + 1 {
    let arg = args[i]
    if after_separator {
      agent_extra_args.push(arg)
    } else if arg == "--" {
      after_separator = true
    } else if arg == "-q" || arg == "--quiet" {
      quiet = true
    } else if arg == "-h" || arg == "--help" {
      show_help = true
    } else if arg == "-V" || arg == "--version" {
      println("nas-moonbit 0.1.0")
      return
    } else if not(arg.has_prefix("-")) {
      profile_name = Some(arg)
    }
  }

  if show_help {
    print_help()
    return
  }

  // Load config
  let cwd = @process.capture_output("pwd")
  let config = try {
    @config.load_config(cwd)
  } catch {
    e => {
      println("Error: " + Show::to_string(e))
      @sys.exit(1)
      return
    }
  }

  // Resolve profile name
  let resolved_name = match profile_name {
    Some(name) => name
    None =>
      match config.default_ {
        Some(d) => d
        None => {
          println("Error: no profile specified and no default profile set")
          @sys.exit(1)
          return
        }
      }
  }

  let profile = match config.profiles.get(resolved_name) {
    Some(p) => p
    None => {
      println("Error: profile '" + resolved_name + "' not found")
      println(
        "Available profiles: " + config.profiles.keys().collect().join(", "),
      )
      @sys.exit(1)
      return
    }
  }

  if not(quiet) {
    println("[nas] Profile: " + resolved_name)
    println("[nas] Agent: " + profile.agent.to_string())
  }

  // Create execution context
  let mut ctx = @pipeline.ExecutionContext::create(
    config, profile, resolved_name, cwd,
  )

  // Add environment variables from profile
  for entry in profile.env {
    ctx.env_vars.set(entry.key, entry.val)
  }

  // Configure basic mounts and env (simplified MountStage)
  let uid = @process.capture_output("id -u")
  let gid = @process.capture_output("id -g")
  let user = @process.capture_output("whoami")
  let nas_home = "/home/" + user
  ctx.docker_args.append(["-v", cwd + ":" + cwd])
  ctx.docker_args.append(["-w", cwd])
  ctx.env_vars.set("WORKSPACE", cwd)
  ctx.env_vars.set("NAS_USER", user)
  ctx.env_vars.set("NAS_HOME", nas_home)
  ctx.env_vars.set("NAS_UID", uid)
  ctx.env_vars.set("NAS_GID", gid)
  ctx.env_vars.set("NAS_LOG_LEVEL", if quiet { "warn" } else { "info" })

  // Configure agent
  match profile.agent {
    @config.Claude => ctx = @agents.configure_claude(ctx)
    _ =>
      println(
        "[nas] Warning: agent " + profile.agent.to_string() +
        " not yet supported in moonbit version",
      )
  }

  // Build pipeline
  let stages : Array[&@pipeline.Stage] = [
    @stages.DockerBuildStage::{},
    @stages.LaunchStage::{ extra_args: agent_extra_args },
  ]

  // Run pipeline
  try {
    let _ = @pipeline.run_pipeline(stages, ctx)
  } catch {
    e => {
      println("[nas] Pipeline error: " + Show::to_string(e))
      @sys.exit(1)
    }
  }
}

fn print_help() -> Unit {
  println("nas-moonbit - Nix Agent Sandbox (MoonBit edition)")
  println("")
  println("Usage: nas-moonbit [OPTIONS] [PROFILE] [-- AGENT_ARGS...]")
  println("")
  println("Options:")
  println("  -q, --quiet     Suppress output")
  println("  -h, --help      Show this help")
  println("  -V, --version   Show version")
  println("")
  println("Profiles are loaded from .agent-sandbox.nix")
}
