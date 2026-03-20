///| Configure Claude Code agent mounts and environment.
pub fn configure_claude(ctx : @pipeline.ExecutionContext) -> @pipeline.ExecutionContext {
  let home = @process.capture_output("echo $HOME")
  let container_home = "/home/user"
  let container_local_bin = container_home + "/.local/bin"

  // Add PATH
  ctx.env_vars.set(
    "PATH",
    container_local_bin + ":/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  )

  // Mount ~/.claude/ (auth + session history)
  let claude_dir = home + "/.claude"
  if @process.exec_ok("test -d " + claude_dir) {
    ctx.docker_args.append(["-v", claude_dir + ":" + container_home + "/.claude"])
  }

  // Mount ~/.claude.json (settings)
  let claude_json = home + "/.claude.json"
  if @process.exec_ok("test -f " + claude_json) {
    ctx.docker_args.append(["-v", claude_json + ":" + container_home + "/.claude.json"])
  }

  // Find claude binary
  let claude_bin = @process.capture_output("which claude 2>/dev/null || true")
  if claude_bin.length() > 0 {
    // Resolve symlinks
    let real_path = @process.capture_output("readlink -f " + claude_bin)
    ctx.docker_args.append(["-v", real_path + ":" + container_local_bin + "/claude:ro"])
    ctx.agent_command = ["claude"]
  } else {
    ctx.agent_command = [
      "bash", "-c",
      "curl -fsSL https://claude.ai/install.sh | bash && claude",
    ]
  }
  ctx
}
