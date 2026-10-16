# dsh-opencode-zen

**OpenCode Zenの無料モデル専用**の、標準DSH/Cordisプラグインです。素の `dsh` で使えます。**RDSHは必須ではありません**（RDSHはエージェントツールの厳格サンドボックスを追加するだけです）。
[English](<README.md>) / [MITライセンス](<LICENSE>) / [安全性](<SECURITY.md>)

配布元: <https://github.com/kuraneko1/dsh-opencode-zen>（MIT）。npmレジストリへの公開は行っていません。GitHub Releaseのtgzから導入します。

## 対応環境

Linux / Node 22.19以上 / `opencode` コマンドが必要です。
素の `dsh` で動作します。プラグインと中継は `rdsh` を一切呼びません。`rdsh` を使うのは、RDSHの厳格ツール境界が維持されることを確認する任意のライブテスト1つだけです。
検証対象はDSH 0.2.0-rc.2、RDSH 0.4.0、OpenCode 1.19.0です。未検証のバージョンへの互換性は宣言しません。
対応するのはテキストのChat Completionsとツール呼び出しです。非Chatモデルは対応を偽装せず一覧から外します。

## 導入（コマンド2つ）

```bash
# 1. プラグインをプロファイルへ追加（dsh でも rdsh でも可）
dsh plugin --profile web add \
  https://github.com/kuraneko1/dsh-opencode-zen/releases/download/v0.2.1/dsh-opencode-zen-0.2.1.tgz

# 2. 資格情報の生成・プロバイダ行の登録・中継のuserサービス化を一度に実行
"${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/.bin/dsh-opencode-zen-setup" --install --profile web --service
```

これで完了です。中継が起動・ヘルスチェックされ、ローカル中継トークンがDSHの `FREEMODELS_API_KEY` に保存され、`opencode-zen` 行が `http://127.0.0.1:8099/v1` を指します。
別ポートなら `--base-url http://127.0.0.1:18099/v1` と `PROXY_PORT=18099` を併せて指定します。
モデル選択で **OpenCode Zen (free)** を選んでください。モデルIDを固定せず、実際のカタログに出るものを使ってください。

**書き込み前の確認**は `--install` を外すだけです: `dsh-opencode-zen-setup --profile web`

### systemdを使わない場合

`--service` は任意です。中継を自分で起動してからsetupを実行します。

```bash
"${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/.bin/dsh-opencode-zen-proxy" run   # 起動したまま
"${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/.bin/dsh-opencode-zen-setup" --install --profile web
```

`--service` は `~/.config/systemd/user/dsh-opencode-zen.service` を生成し（Type=simple、失敗時再起動、`NoNewPrivileges`、`PrivateTmp`、Nodeと`opencode`の絶対パス、個人パスを含まない）、`systemctl --user enable --now` を実行します。
確認は `systemctl --user cat dsh-opencode-zen.service`、停止は `systemctl --user disable --now dsh-opencode-zen.service`。編集済みユニットは再生成前にバックアップされます。

### ソースから作る場合

```bash
git clone https://github.com/kuraneko1/dsh-opencode-zen.git && cd dsh-opencode-zen
npm ci --ignore-scripts && npm test && npm pack
dsh plugin --profile web add "$PWD/dsh-opencode-zen-0.2.1.tgz"
```

`git+https://…` をプラグイン指定子にしないでください。pnpmがgit取得パッケージをビルド対象として扱い、DSHが承認までブロックします。Releaseのtgzかローカルのtgz/ディレクトリを使ってください。

### 旧版からの移行

setupは以前追加した `providers.freemodels` を削除し、Zen専用プラグインへ切り替えます。
そこに含まれていた他社モデルも消えますが、元からユーザーが設定していた別プロバイダ・資格情報・既定モデルは維持します。
変更前に非公開バックアップを作り、DSHと同じロック/atomic writeを使います。2ファイル全体のトランザクションではないため、途中失敗時はバックアップ確認後に再実行してください。

## 設定・状態の場所

```yaml
- id: opencode-zen
  config:
    proxyURL: http://127.0.0.1:8099/v1
    apiKeyEnv: FREEMODELS_API_KEY
```

通常はバンドルの既定値のままで使えます。鍵そのものをYAMLへ書かないでください。
モデル一覧は認証付きで取得し、60秒ごとに再取得します。不明/有料/不正なモデルや、壊れた一覧へはフェイルクローズします。

実行時データはnpmパッケージ内ではなく、`$XDG_STATE_HOME/dsh-opencode-zen` または `~/.local/state/dsh-opencode-zen` に置きます。
絶対パスの `FREEMODELS_RUNTIME_DIR` で変更できます。親0700、鍵0600です。
OpenCodeは4096、中継は8099が既定です。`OC_PORT` / `PROXY_PORT` で変更したら `proxyURL` とsetupの `--base-url` も合わせてください。

Webの設定だけならHMR有効時にlive反映されます。ただし**パッケージ本体の交換**は別で、ホスト再起動が必要な場合があります。
ブラウザの更新だけで、読み込み済みJSまで置き換わるとは限りません。

## 検証・制約

```bash
npm test
npm pack --dry-run --ignore-scripts

# 中継を起動済みの環境で、実モデルを呼ぶ明示的テスト
node bridge-smoke.mjs            # 実Zenのツール呼び出し＋クライアント側だけの結果
node rdsh-smoke.mjs              # 任意：RDSHの厳格境界で同じ証明を行う版
```

[RDSHテスト](<rdsh-smoke.mjs>)は、このリポジトリで唯一RDSHに依存する部分です。
一時プロファイルに**本物のプラグイン**を読み込み、共有したランダムなファイルだけを `rdsh_inspect` で読み、隔離ツール出力と最終回答の両方が一致することを確認します。
RDSH側のネットワーク・書き込み・資格情報隔離は解除しません。外側サンドボックスが入れ子namespaceを禁止している場合はホストで実行してください。素の `dsh` での利用にこれらは不要です。

認証・loopback限定・SSE検証・メモリ/並列上限・切断キャンセルなどは維持しています。
提供元の403を隠したり、ダミーツールやヘッダ偽装で回避したりしません。ツールなしの要求は提供元に403で拒否されることがあります。
無料枠の継続、全モデル、長時間負荷、将来バージョン、依存物の完全性を保証するものではありません。[監査メモ](<AUDIT.md>)も参照してください。

## OSSとしての配布

MITライセンス、通常のnpm依存/peer依存、lockfile、標準バンドル定義、ローカルテストを備えています。
配布対象はallowlistで限定し、資格情報・実行時データ・個人のバックアップ・旧調査ファイルは含めません。
ソースは <https://github.com/kuraneko1/dsh-opencode-zen> で公開しています。
**npmレジストリへの公開は行っていません。** 配布はGitHub Releaseのtgzで行います。
