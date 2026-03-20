///| LaunchStage: runs the Docker container with the agent.
pub(all) struct LaunchStage {
  extra_args : Array[String]
}

///| Implement Stage for LaunchStage.
pub impl @pipeline.Stage for LaunchStage with name(_self) -> String {
  "LaunchStage"
}

pub impl @pipeline.Stage for LaunchStage with execute(
  self,
  ctx
) -> @pipeline.ExecutionContext raise Error {
  // Build the full command
  let command : Array[String] = []
  command.append(ctx.agent_command)
  command.append(ctx.profile.agent_args)
  command.append(self.extra_args)

  println("[nas] Launching container...")
  println("[nas]   Image: " + ctx.image_name)
  println("[nas]   Agent: " + ctx.profile.agent.to_string())
  println("[nas]   Command: " + command.iter().collect().join(" "))

  // Build docker run arguments
  let args : Array[String] = []
  args.push("--rm")
  args.push("-it")

  // Add environment variables
  ctx.env_vars.each(fn(k, v) { args.append(["-e", k + "=" + v]) })

  // Add docker args from context
  args.append(ctx.docker_args)

  // Image name
  args.push(ctx.image_name)

  // Command
  args.append(command)

  let exit_code = @docker.run(args)
  if exit_code != 0 {
    println("[nas] Container exited with code " + exit_code.to_string())
  }
  ctx
}
