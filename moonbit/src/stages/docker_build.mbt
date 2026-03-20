///| DockerBuildStage: builds the Docker image if it doesn't exist.
pub(all) struct DockerBuildStage {}

///| Implement Stage for DockerBuildStage.
pub impl @pipeline.Stage for DockerBuildStage with name(_self) -> String {
  "DockerBuildStage"
}

pub impl @pipeline.Stage for DockerBuildStage with execute(
  _self,
  ctx
) -> @pipeline.ExecutionContext raise Error {
  let image_name = ctx.image_name
  if @docker.image_exists(image_name) {
    println("[nas] Docker image \"" + image_name + "\" already exists, skipping build")
  } else {
    println("[nas] Building Docker image \"" + image_name + "\"...")
    // Build from the embed directory (simplified: use existing Dockerfile path)
    let embed_dir = find_embed_dir()
    let exit_code = @docker.build(embed_dir, image_name)
    if exit_code != 0 {
      raise Failure::Failure("Docker build failed with exit code " + exit_code.to_string())
    }
  }
  ctx
}

///| Find the embed directory relative to the project.
fn find_embed_dir() -> String {
  // Look for src/docker/embed relative to the git root
  let git_root = @process.capture_output("git rev-parse --show-toplevel")
  let embed = git_root + "/src/docker/embed"
  if @process.exec_ok("test -d " + embed) {
    return embed
  }
  // Fallback: current directory
  "."
}
