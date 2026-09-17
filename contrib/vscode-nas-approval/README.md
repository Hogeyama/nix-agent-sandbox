# nas-approval

Routes nas Dev Container approval requests (hostexec / network) into the
attached VS Code window. Active only when `vscode.env.remoteName` is
`dev-container` and the workspace is registered with `nas devcontainer`.

## Install (nix / home-manager)

```nix
programs.vscode.extensions = [
  (pkgs.vscode-utils.buildVscodeExtension {
    pname = "nas-approval";
    version = "0.1.0";
    src = <path to>/contrib/vscode-nas-approval;
  })
];
```

## Install (vsix)

```sh
bun x @vscode/vsce package --no-dependencies   # produces nas-approval-0.1.0.vsix
code --install-extension nas-approval-0.1.0.vsix
```

## Install (manual)

Copy this directory to
`~/.vscode/extensions/nas.nas-approval-0.1.0/` and restart VS Code.

## Settings

- `nas-approval.nasPath` — path to the `nas` binary (default: `nas`).
