---
name: moonbit_nix_setup
description: How to set up MoonBit toolchain via Nix - overlay broken, official installer works
type: reference
---

## MoonBit Nix セットアップ (2026-03-20)

### moonbit-overlay (壊れている)
- `github:moonbit-community/moonbit-overlay` は存在するが、core library の bundle が空 (32 bytes) でビルドが通らない。
- `pkgs.moonbit-bin.moonbit.latest` でパッケージは取得できるが、`println` すら解決できない。
- **使わないこと。**

### 公式インストーラ（動作する）
- `curl -fsSL https://cli.moonbitlang.com/install/unix.sh | bash` で `$MOON_HOME` にインストール。
- `MOON_HOME` 環境変数でインストール先を制御。
- bundle ステップも自動で実行される。
- native backend (LLVM) は標準で含まれる。

### Nix devShell 設定
```nix
devShells.moonbit = pkgs.mkShell {
  packages = with pkgs; [ curl gcc ];
  shellHook = ''
    export MOON_HOME="''${MOON_HOME:-$PWD/.moonbit-toolchain}"
    export PATH="$MOON_HOME/bin:$PATH"
    export LIBRARY_PATH="${pkgs.glibc}/lib"  # tcc がリンク時に必要
    if [ ! -x "$MOON_HOME/bin/moon" ]; then
      curl -fsSL https://cli.moonbitlang.com/install/unix.sh | bash
    fi
  '';
};
```

### 重要: LIBRARY_PATH
- MoonBit native backend は内蔵 tcc (Tiny C Compiler) でリンクする。
- tcc は `-lpthread -lc` を要求するが、NixOS では標準パスに libc がない。
- `LIBRARY_PATH=${pkgs.glibc}/lib` を設定すること。

### moon update (レジストリ更新)
- `moon update` は git clone でレジストリインデックスを取得する。
- nas (hostexec) 環境内では git が制限されているため失敗することがある。
- ホスト環境で実行すること。

**Why:** Nix での MoonBit セットアップは一筋縄ではいかない。overlay は壊れており、公式インストーラ + LIBRARY_PATH が唯一の動作する組み合わせ。

**How to apply:** MoonBit を Nix で使うときはこの手順に従う。overlay が修正されたら再検討。
