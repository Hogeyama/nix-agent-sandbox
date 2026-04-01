namespace Nas.Core.Pipeline

open System.Threading.Tasks
open Nas.Core

type IStage =
    abstract member Name: string
    abstract member Execute: ExecutionContext -> Task<ExecutionContext>
    abstract member Teardown: ExecutionContext -> Task<unit>

module Pipeline =
    let run (stages: IStage list) (ctx: ExecutionContext) =
        task {
            let mutable currentCtx = ctx
            let mutable completedStages: IStage list = []
            try
                for stage in stages do
                    Log.info $"Running stage: {stage.Name}"
                    let! newCtx = stage.Execute(currentCtx)
                    currentCtx <- newCtx
                    completedStages <- stage :: completedStages
                return Ok currentCtx
            with ex ->
                Log.error $"Pipeline failed: {ex.Message}"
                for stage in completedStages do
                    try
                        Log.info $"Tearing down: {stage.Name}"
                        do! stage.Teardown(currentCtx)
                    with teardownEx -> Log.warn $"Teardown error in {stage.Name}: {teardownEx.Message}"
                return Error ex
        }

    let teardownAll (stages: IStage list) (ctx: ExecutionContext) =
        task {
            for stage in List.rev stages do
                try do! stage.Teardown(ctx)
                with ex -> Log.warn $"Teardown error in {stage.Name}: {ex.Message}"
        }
