# dsh-opencode-zen

[English](<README.en.md>) ・ [MIT](<LICENSE>) ・ [監査メモ](<AUDIT.md>)

OpenCode Zen の**無料モデル専用**のDSHプラグイン。素の `dsh` でもRDSHでも動きます。
実ツールを実行するのは呼び出し元のDSH/RDSHだけで、上流のOpenCodeは中継に徹します。

## 必要なもの

Linux / Node 22.19以上 / **`opencode` コマンド**（PATHにあるか `OPENCODE_BIN=/path/to/opencode` で指定）。
Zenの無料枠はOpenCode本体からのリクエストしか受け付けないため、これが上流クライアントになります。

## インストール

```bash
curl -fsSL https://raw.githubusercontent.com/kuraneko1/dsh-opencode-zen/main/install.sh | bash
```

既定ではプロファイル `web` に入れ、中継を systemd user サービスとして常駐させます。

| 変更したい | やり方 |
|---|---|
| 別プロファイル | `PROFILE=tui bash install.sh` |
| サービス化しない | `SERVICE=0 bash install.sh`（中継は自分で `dsh-opencode-zen-proxy run`） |
| 中継を止める | `systemctl --user disable --now dsh-opencode-zen.service` |

手動で入れる場合:

```bash
dsh plugin --profile web add https://github.com/kuraneko1/dsh-opencode-zen/releases/download/v0.2.5/dsh-opencode-zen-0.2.5.tgz
"${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/.bin/dsh-opencode-zen-setup" --install --profile web --service
```

インストール後、モデル選択で **OpenCode Zen（無料）** を選びます。既定モデルは変更しません。

## 知っておくこと

- **長いセッション**: `deepseek-v4.1-flash-free` と `glm-5.3-flash-free` は実測1M（999,312 / 1,047,653トークン）として宣言します。他のモデルは公開値のまま。実測は `node bench-context.mjs zen/<id> 250000`
- **ツールなしの単発要求**は提供元が403 `FreeTierError` を返します。DSHは実際のツールを送るので通常利用は通ります
- **空のプロファイル**では、DSH自身の依存のビルド承認を求められることがあります（`pnpm approve-builds`）。このプラグインにビルドスクリプトはありません
- 認証付きloopback限定。ローカル中継トークンは `~/.local/state/dsh-opencode-zen`（0600）に生成し、**ZenのAPIキーは不要**です
- 無料枠の継続・全モデル・将来バージョンは保証しません

困ったときは [AUDIT.md](<AUDIT.md>)（監査・既知の限界）と [CHANGELOG.md](<CHANGELOG.md>)。
