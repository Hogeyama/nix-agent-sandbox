# diffity (https://github.com/nilbuild/diffity) の Nix パッケージ。
#
# upstream は npm 配布のみで flake を持たないため、公開済みの npm パッケージを
# そのまま取り込む。`./package.json` は「diffity 本体を 1 依存として持つだけ」の
# シムで、`npm ci` に食わせる lockfile を固定するためだけに存在する。
# こうすると devDependencies (esbuild / typescript / tsx) が lockfile に載らず、
# 取得する依存が実行時に必要な 5 つとその推移閉包だけで済む。
#
# 更新手順:
#   1. ./package.json の diffity バージョンを上げる
#   2. npm install --prefix nix/diffity --package-lock-only --ignore-scripts
#   3. 下の npmDepsHash を lib.fakeHash に戻して nix build し、表示された値を書く
{ lib, buildNpmPackage, nodejs, makeWrapper, python3 }:

buildNpmPackage {
  pname = "diffity";
  version = (lib.importJSON ./package.json).dependencies.diffity;

  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [ ./package.json ./package-lock.json ];
  };

  npmDepsHash = "sha256-QXNH8dRZWS2Ohtg7FSWGaz042WmWLSmogV4RJjz9imk=";

  # better-sqlite3 は install スクリプトで prebuild-install を試みる。サンドボックス
  # 内はネットワークが無く必ず失敗するので、最初から node-gyp ビルドへ倒す。
  npm_config_build_from_source = "true";
  nativeBuildInputs = [ makeWrapper python3 ];

  # シム自身には build スクリプトが無い。実体は npm レジストリ上の完成品。
  dontNpmBuild = true;

  installPhase = ''
    runHook preInstall

    mkdir -p $out/lib/diffity
    cp -r node_modules $out/lib/diffity/node_modules

    # shebang は `#!/usr/bin/env node` なので直接 exec せず node を明示して包む。
    makeWrapper ${lib.getExe nodejs} $out/bin/diffity \
      --add-flags $out/lib/diffity/node_modules/diffity/dist/index.js

    runHook postInstall
  '';

  meta = {
    description = "GitHub-style git diff viewer and code review tool for AI coding agents";
    homepage = "https://diffity.com";
    mainProgram = "diffity";
    # 上流は 2026-04-14 の "chore: license to mit" で MIT へ再ライセンス済み。
    # ただし 0.9.5 の公開 (2026-04-02) はそれより前なので、npm 上の
    # package.json だけが "PolyForm-Shield-1.0.0" のまま残っている。
    # ここは実体である上流リポジトリの LICENSE に合わせる。
    license = lib.licenses.mit;
  };
}
