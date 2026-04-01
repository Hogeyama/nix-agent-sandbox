namespace Nas.Core.Config

open FluentValidation
open Nas.Core

type ProfileValidator() =
    inherit AbstractValidator<Profile>()
    do
        base.RuleForEach(fun p -> p.Network.Allowlist)
            .Must(Validate.isValidAllowlistEntry)
            .WithMessage("Allowlist entry must be '*.domain.com' or exact host. Got: '{PropertyValue}'") |> ignore
        base.RuleFor(fun p -> p.Network.Prompt.TimeoutSeconds)
            .GreaterThan(0).WithMessage("Network prompt timeout must be positive") |> ignore

type ConfigValidator() =
    inherit AbstractValidator<Config>()
    do
        base.RuleFor(fun c -> c.Ui.Port)
            .InclusiveBetween(1, 65535).WithMessage("UI port must be between 1 and 65535") |> ignore
