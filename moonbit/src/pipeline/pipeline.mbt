///| A pipeline stage that transforms the execution context.
pub(open) trait Stage {
  ///| Name of the stage.
  name(Self) -> String
  ///| Execute the stage, returning a modified context.
  execute(Self, ExecutionContext) -> ExecutionContext raise Error
}

///| Run stages sequentially, returning the final context.
pub fn run_pipeline(
  stages : Array[&Stage],
  ctx : ExecutionContext
) -> ExecutionContext raise Error {
  let mut current = ctx
  for stage in stages {
    println("[nas] Running stage: " + stage.name())
    current = stage.execute(current)
  }
  current
}
