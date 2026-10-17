# dsh-opencode-zen

[English](<README.en.md>) ・ [MIT](<LICENSE>) ・ [監査メモ](<AUDIT.md>)

OpenCode Zen の**無料モデル専用**のDSHプラグイン。素の `dsh` でもRDSHでも動きます。

![構成](flow.png)

## 必要なもの

| 必要なもの | 理由 |
|---|---|
| **`opencode` コマンド** | **必須**。Zenの無料枠は「OpenCode本体からの要求」しか受け付けません。中継がこれを上流クライアントとして自動起動します。`PATH` にあるか `OPENCODE_BIN=/path/to/opencode` |
| Linux / Node 22.19以上 | 中継に必要（systemdは任意） |
| `pnpm` | プラグインマネージャが使用。`install.sh` は `corepack` で自動有効化を試み、無理なら `npm i -g pnpm` を案内します |

OpenCodeを入れたくない場合、このプラグインは使えません。DSH標準のプロバイダ（`deepseek-official` や `opencode-go` など）を使ってください。

プロファイルが無い環境では、`install.sh` が `dsh plugin` にプロファイル作成を任せます（手動準備は不要）。
systemdが無い環境（コンテナ等）では中継をバックグラウンドで起動します。

## ポート

| ポート | 用途 | 変更 |
|---|---|---|
| **8099** | アプリが見る唯一の窓口（ローカル中継）。トークン必須 | `PROXY_PORT` |
| 4096 | 中継が内部で起動する専用OpenCode。直接使う必要なし | `OC_PORT` |
| — | 鍵と状態の置き場（0600） | `FREEMODELS_RUNTIME_DIR` |

既定は `8099` と `4096`、状態は `~/.local/state/dsh-opencode-zen`。ポートを変えるときは `dsh-opencode-zen-setup` に `--base-url http://127.0.0.1:<PROXY_PORT>/v1` も渡してください。

## インストール

```bash
curl -fsSL https://raw.githubusercontent.com/kuraneko1/dsh-opencode-zen/main/install.sh | bash
```

| 変更したい | やり方 |
|---|---|
| 別プロファイル | `PROFILE=tui bash install.sh` |
| サービス化しない | `SERVICE=0 bash install.sh` |
| OpenCodeの場所を指定 | `OPENCODE_BIN=/opt/opencode/opencode bash install.sh` |
| 中継を止める | `systemctl --user disable --now dsh-opencode-zen.service` |

手動で入れる場合:

```bash
dsh plugin --profile web add https://github.com/kuraneko1/dsh-opencode-zen/releases/download/v0.2.10/dsh-opencode-zen-0.2.10.tgz
"${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/.bin/dsh-opencode-zen-setup" --install --profile web --service
```

インストール後、モデル選択で **OpenCode Zen（無料）** を選びます。既定モデルは変更しません。

## 無料枠が拒否されるとき

`OpenCode's free tier can only be used from within OpenCode` という403は、**本物のOpenCodeからでも返ります**。
検証済みの例: まっさらなコンテナにOpenCode 1.19.3を入れ、設定もプラグインも無しで `opencode run` した場合、
およびホストのOpenCode 1.19.0で同じ結果でした。プロバイダ側の判定なので、このプラグインでは回避しません
（クライアント偽装はしません）。時間を置くか、別のプロバイダを使ってください。

## 知っておくこと

- **長いセッション**: `deepseek-v4.1-flash-free` と `glm-5.3-flash-free` は実測1M（999,312 / 1,047,653トークン）として宣言します。他モデルは公開値のまま
- **ツールなしの単発要求**は提供元が403 `FreeTierError` を返します。DSHは実際のツールを送るので通常利用は通ります
- **空のプロファイル**ではDSH自身の依存のビルド承認を求められることがあります（`pnpm approve-builds`）。このプラグインにビルドスクリプトはありません
- 認証付きloopback限定。**ZenのAPIキーは不要**です（中継トークンだけを生成します）
- 無料枠の継続・全モデル・将来バージョンは保証しません

詳しい制約は [AUDIT.md](<AUDIT.md>)、変更履歴は [CHANGELOG.md](<CHANGELOG.md>)。
