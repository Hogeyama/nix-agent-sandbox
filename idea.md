
# 設定ファイルの解決方法

* `nas config init` または初回の `nas run` で以下のファイルを生成
  * `$XDG_CONFIG_HOME/Schema.pkl`
    * CLIに同梱したassetsから吐く。1行
      ```
      amends "Schema.pkl"
      ```
    * 自分のバージョンより古いバージョンの`Schema.pkl`が存在したら上書き
  * `.nas/Schema.pkl`
    * CLIに同梱したassetsから吐く
    * 自分のバージョンより古いバージョンの`Schema.pkl`が存在したら上書き
  * `$XDG_CONFIG_HOME/global.pkl`
    * CLIに同梱したassetsから吐く
      ```
      amends "Schema.pkl"

      // Add your custom global config here
      ```
    * 既に存在したらスキップ
  * `.nas/config.pkl`
    * CLIに同梱したassetsから吐く
      ```
      amends "modulepath:/global.pkl"
      // Comment out above line and uncomment below line to ignore global config
      // amends "Schema.pkl"

      // Add your custom config here
      ```
  * `.nas/PklProject`
    * CLIに同梱したassetsから吐く
      ```
       amends "pkl:Project"

       local globalConfigDir = (read?("env:XDG_CONFIG_HOME") ?? "\(read("env:HOME"))/.config") + "/nas"

       evaluatorSettings {
         modulePath {
           "."
           globalConfigDir
         }
       }
      ```
    * 既に存在したらスキップ
  * `.nas/.gitignore`
    * 中身は `*`
* `nas config migrate pkl` で以下をやる
  * `.agent-sandbox.{yml,nix}` をどうにかして `.nas/config.pkl` に変換
