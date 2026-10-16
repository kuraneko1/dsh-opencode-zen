# dsh-opencode-zen

**OpenCode Zenの無料モデル専用**の、標準DSH/Cordisプラグインです。RDSHからも通常のプラグインとして使えます。
[English](<README.md>) / [MITライセンス](<LICENSE>) / [安全性](<SECURITY.md>)

配布元: <https://github.com/kuraneko1/dsh-opencode-zen>（MIT）。npmレジストリへの公開は行っていません。tgzまたはGitリポジトリから導入します。

## 今回の構成

- [本体](<index.mjs>)が専用プロバイダ `opencode-zen` を登録します。導入スクリプトだけをプラグインと呼ぶ構成ではありません。
- 既存の `llm-pi-ai` をもう1つ起動せず、公開されている `PiAiAdapter` を利用します。他のプロバイダや既定モデルを置換しません。
- OpenRouter・NVIDIA・ローカルの経路はありません。Zen以外のIDは拒否します。
- 専用OpenCodeはキーなし・空の認証ファイルで起動し、ホストの資格情報を読み取り/コピーしません。
- 実ツールは呼び出し元のRDSH/DSHだけが実行します。OpenCodeは中継のみです。

## 対応環境

Linux / Node 22.19以上 / `opencode` コマンドが必要です。
検証対象はDSH 0.2.0-rc.2、RDSH 0.4.0、OpenCode 1.19.0です。未検証のバージョンへの互換性は宣言しません。
対応するのはテキストのChat Completionsとツール呼び出しです。非Chatモデルは対応を偽装せず一覧から外します。

## 導入

```bash
# このソースディレクトリで
npm ci --ignore-scripts
npm test
npm pack

# 作成したtgzを標準のプラグイン管理から導入
rdsh plugin --profile web add /absolute/path/dsh-opencode-zen-0.2.0.tgz

# Gitリポジトリから直接導入することもできます
rdsh plugin --profile web add git+https://github.com/kuraneko1/dsh-opencode-zen.git
```

[バンドル定義](<cordis.patch.yml>)から本物のプラグイン本体が読み込まれます。
次に、別ターミナルで中継プロセスを起動してください。プラグインの読み込みが勝手にデーモンを起動することはありません。

```bash
"${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/.bin/dsh-opencode-zen-proxy" run

# もう1つのターミナルで、変更予定だけ確認→適用
"${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/.bin/dsh-opencode-zen-setup" --profile web
"${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/.bin/dsh-opencode-zen-setup" --install --profile web
```

設定する鍵は**ローカル中継への認証用**であり、Zen APIキーではありません。
モデル選択で **OpenCode Zen (free)** を選びます。モデルIDを固定せず、実際のカタログに出るものを使ってください。
サービス化には[systemd例](<freemodels-proxy.service>)を使えます。インストール先とNodeのPATHは環境に合わせて変更してください。

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
node bridge-smoke.mjs
node rdsh-smoke.mjs
```

[RDSHテスト](<rdsh-smoke.mjs>)は一時プロファイルに**本物のプラグイン**を読み込みます。
共有したランダムなファイルだけを `rdsh_inspect` で読み、隔離ツール出力と最終回答の両方が一致することを確認します。
RDSH側のネットワーク・書き込み・資格情報隔離は解除しません。外側サンドボックスが入れ子namespaceを禁止している場合はホストで実行してください。

認証・loopback限定・SSE検証・メモリ/並列上限・切断キャンセルなどは維持しています。
提供元の403を隠したり、ダミーツールやヘッダ偽装で回避したりしません。ツールなしの要求は提供元に403で拒否されることがあります。
無料枠の継続、全モデル、長時間負荷、将来バージョン、依存物の完全性を保証するものではありません。[監査メモ](<AUDIT.md>)も参照してください。

## OSSとしての配布

MITライセンス、通常のnpm依存/peer依存、lockfile、標準バンドル定義、ローカルテストを備えています。
配布対象はallowlistで限定し、資格情報・実行時データ・個人のバックアップ・旧調査ファイルは含めません。
ソースは <https://github.com/kuraneko1/dsh-opencode-zen> で公開しています。
**npmレジストリへの公開は行っていません。** tgzまたはGitチェックアウトから利用できます。
