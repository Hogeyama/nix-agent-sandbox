// strait's entry point: route a subcommand, or launch the sandbox.
//
//   strait [--config strait.json] [--name NAME] [--debug] -- command [args...]
//   strait review ...     approve or deny held requests, on the host (ui/review.ts)
//   strait hostexec ...   ask to run a command on the host, from the sandbox
//                         (ui/hostexec_client.ts)
//
// Only src/core decides what leaves the sandbox or runs on the host. The UI
// under src/ui is wired in here, through hooks that cannot widen the policy.
// To sandbox a program called review or hostexec, put it after `--`.

import { resolve } from "node:path";
import { fail, run, STRAIT_ROOT } from "./core/main.ts";
import { hostexecMain } from "./ui/hostexec_client.ts";
import { notifier } from "./ui/notify.ts";
import { reviewMain } from "./ui/review.ts";
import { findStatusLine, wrapStatusLine } from "./ui/statusline.ts";

const argv = process.argv.slice(2);
if (argv[0] === "review") {
  process.exit(await reviewMain(argv.slice(1)));
} else if (argv[0] === "hostexec") {
  process.exitCode = await hostexecMain(argv.slice(1));
} else {
  run(argv, {
    command: (given) =>
      wrapStatusLine(
        given,
        findStatusLine(process.cwd(), process.env),
        resolve(STRAIT_ROOT, "strait-statusline"),
      ),
    onPending: notifier,
  }).catch(fail);
}
