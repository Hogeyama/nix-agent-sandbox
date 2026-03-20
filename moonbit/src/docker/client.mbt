///| Check if a Docker image exists locally.
pub fn image_exists(tag : String) -> Bool {
  @process.exec_ok("docker image inspect " + tag + " > /dev/null 2>&1")
}

///| Build a Docker image from a context directory.
pub fn build(context_dir : String, tag : String) -> Int {
  @process.exec(
    "docker build -t " + tag + " " + context_dir,
  )
}

///| Run a Docker container interactively with the given arguments.
/// Returns the exit code.
pub fn run(args : Array[String]) -> Int {
  let cmd = StringBuilder::new()
  cmd.write_string("docker run")
  for arg in args {
    cmd.write_string(" ")
    cmd.write_string(arg)
  }
  @process.exec(cmd.to_string())
}
