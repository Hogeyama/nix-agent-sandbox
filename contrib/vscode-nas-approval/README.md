# nas-approval

Routes nas Dev Container approval requests (hostexec / network) into the
attached VS Code window, for workspaces registered with `nas devcontainer`.

## Install (release vsix)

```sh
curl -fsSLo /tmp/nas-approval.vsix https://github.com/Hogeyama/nix-agent-sandbox/releases/download/vscode-nas-approval-latest/nas-approval.vsix
code --install-extension /tmp/nas-approval.vsix
```

This URL always points to the newest release. To pin a version, download the
versioned `nas-approval-<version>.vsix` asset from a `vscode-nas-approval-v*`
tag instead (the extension is released separately from nas).

## Install (nix build)

```sh
nix build github:Hogeyama/nix-agent-sandbox#vscode-nas-approval
code --install-extension result/nas-approval-*.vsix
```

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

## Install (manual)

Copy this directory to
`~/.vscode/extensions/nas.nas-approval-0.1.0/` and restart VS Code.

## Settings

- `nas-approval.nasPath` — command used to run `nas` (default: `nas`, found
  via PATH). Can be a full command line rather than just a path, so `nas`
  can be reached through another layer when it isn't on this machine. On
  Windows with `nas` in WSL2, this is attempted automatically (best effort);
  if that doesn't work, set it explicitly:

  ```json
  "nas-approval.nasPath": "wsl.exe -d <DISTRO> nas"
  ```
