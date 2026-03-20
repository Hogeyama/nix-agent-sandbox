// A test stage that appends its name to docker_args for tracing.
struct TraceStage {
  tag : String
}

impl Stage for TraceStage with name(self) -> String {
  self.tag
}

impl Stage for TraceStage with execute(
  self,
  ctx
) -> ExecutionContext raise Error {
  ctx.docker_args.push("ran:" + self.tag)
  ctx
}

test "run_pipeline: stages execute in order" {
  let config : @config.Config = {
    default_: None,
    profiles: {},
  }
  let ctx = ExecutionContext::create(
    config, @config.Profile::default_(), "test", "/tmp",
  )
  let stages : Array[&Stage] = [
    TraceStage::{ tag: "A" },
    TraceStage::{ tag: "B" },
    TraceStage::{ tag: "C" },
  ]
  let result = run_pipeline(stages, ctx)
  inspect(result.docker_args, content=(
    #|["ran:A", "ran:B", "ran:C"]
  ))
}

test "run_pipeline: empty stages" {
  let config : @config.Config = {
    default_: None,
    profiles: {},
  }
  let ctx = ExecutionContext::create(
    config, @config.Profile::default_(), "test", "/tmp",
  )
  let result = run_pipeline([], ctx)
  inspect(result.docker_args, content=(
    #|[]
  ))
}
