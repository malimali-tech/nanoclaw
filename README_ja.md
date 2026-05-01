<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  軽量なパーソナル AI アシスタント。pi-coding-agent はホストプロセス内で動作し、bash コマンドは <code>sandbox-exec</code> / <code>bubblewrap</code> でサンドボックス化されます。理解しやすく、あなたのニーズに合わせて完全にカスタマイズできます。
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="https://docs.nanoclaw.dev">docs</a>&nbsp; • &nbsp;
  <a href="README.md">English</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>
</p>

> **このフォークについて：** このフォークは Feishu / Lark チャネルのみを内蔵しています。アップストリーム NanoClaw のマルチチャネルスキル（add-whatsapp / add-telegram / add-slack / add-discord）はここでは利用できず、対応するランタイムコードとセットアップ手順も削除されています。

---

## なぜ NanoClaw を作ったのか

[OpenClaw](https://github.com/openclaw/openclaw) は素晴らしいプロジェクトですが、よく理解できないソフトウェアに自分の生活への完全なアクセス権を与えるのは安心できませんでした。OpenClaw は約 50 万行のコード、53 個の設定ファイル、70 以上の依存関係を持ちます。セキュリティはアプリケーションレベル（許可リスト、ペアリングコード）で、真の OS レベル分離ではありません。すべてが共有メモリの単一 Node プロセスで動作します。

NanoClaw は同じコア機能を、理解できるサイズのコードベースで提供します：1 プロセス、ほんの数ファイル。Coding agent は [`@mariozechner/pi-coding-agent`](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) を介してプロセス内で動作し、bash コマンドは `sandbox-exec`（macOS）または `bubblewrap`（Linux）を使用して OS レベルで分離されます — 単なる権限チェックではありません。

## クイックスタート

```bash
gh repo fork malimali-tech/nanoclaw --clone
cd nanoclaw
claude
```

<details>
<summary>GitHub CLI なしの場合</summary>

1. GitHub で [malimali-tech/nanoclaw](https://github.com/malimali-tech/nanoclaw) を Fork
2. `git clone https://github.com/<your-username>/nanoclaw.git`
3. `cd nanoclaw`
4. `claude`

</details>

そして `/setup` を実行。Claude Code がすべてを処理します：依存関係、認証、サンドボックス設定、サービス起動。

> **注意：** `/`で始まるコマンド（`/setup`、`/customize`など）は [Claude Code スキル](https://code.claude.com/docs/en/skills)です。通常のターミナルではなく、`claude` CLI プロンプト内で入力してください。Claude Code をインストールしていない場合は、[claude.com/product/claude-code](https://claude.com/product/claude-code)から入手してください。

## 設計哲学

**理解できるサイズ。** 1 プロセス、数個のソースファイル、マイクロサービスなし。NanoClaw のコードベース全体を理解したい？Claude Code に解説してもらってください。

**分離によるセキュリティ。** エージェントの bash コマンドは OS レベルのサンドボックス内で動作します — macOS では `sandbox-exec`、Linux では `bubblewrap` — `config/sandbox.default.json` で設定され、グループごとに上書き可能です。ファイルシステムとネットワークアクセスは権限チェックではなくポリシーで制限されます。

**個人ユーザーのために。** NanoClaw はモノリシックなフレームワークではなく、各ユーザーのニーズに正確に合うソフトウェアです。Fork して Claude Code に好みに合わせて改変してもらいます。

**カスタマイズ = コード変更。** 設定の氾濫なし。動作を変えたい？コードを変更します。コードベースは小さいので安全です。

**AI ネイティブ。**
- インストールウィザードなし。Claude Code がセットアップを案内。
- 監視ダッシュボードなし。Claude に何が起きているか聞く。
- デバッグツールなし。問題を説明すれば Claude が直す。

**機能追加ではなくスキル。** コードベースに新しい統合を追加する代わりに、コントリビューターは [Claude Code スキル](https://code.claude.com/docs/en/skills)（例：`/add-macos-statusbar`、`/customize`）を提出してフォークを変換します。Feishu は本フォークでは `main` に直接組み込まれており、スキルではありません。

**Pi-coding-agent をプロセス内で実行。** NanoClaw は [`@mariozechner/pi-coding-agent`](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) を直接埋め込みます — サブプロセスもコンテナビルドもありません。Provider は標準の環境変数（`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY`、…）または `~/.pi/agent/auth.json` で選択します。

## サポート機能

- **Feishu / Lark メッセージング** - 公開 URL なしの WebSocket 長時間接続で、Feishu（中国国内）または Lark（国際）グループからアシスタントと会話。このフォークは Feishu チャネルのみを提供しています。他のチャネルはアップストリームのスキルでここでは適用されません。
- **隔離されたグループコンテキスト** - 各グループには独自の `CLAUDE.md` メモリと作業ディレクトリがあります。bash コマンドはグループごとのサンドボックスプロファイルで保護されます。
- **メインチャンネル** - 管理用のプライベートチャネル（self-chat）。他のすべてのグループは完全に隔離。
- **スケジュールされたタスク** - エージェントを実行し、メッセージを返信できる定期ジョブ。
- **Web アクセス** - 検索とコンテンツ取得。
- **OS レベルのサンドボックス** - bash コマンドは `sandbox-exec`（macOS）または `bubblewrap`（Linux）経由で実行。ルールは `config/sandbox.default.json` にあり、`groups/<group>/.pi/sandbox.json` でグループごとに上書き可能。
- **マルチプロバイダー** - Pi-coding-agent は Anthropic、OpenAI、Gemini、DeepSeek などをサポート。env vars または `~/.pi/agent/auth.json` で設定。

## 使い方

トリガーワード（デフォルト：`@Andy`）でアシスタントと話します：

```
@Andy 平日午前 9 時に営業パイプラインの概要を送信（Obsidian vault フォルダにアクセス可能）
@Andy 毎週金曜日に過去 1 週間の git 履歴をレビューし、ずれがあれば README を更新
@Andy 毎週月曜日午前 8 時に Hacker News と TechCrunch から AI 開発のニュースをまとめてブリーフィング
```

メインチャンネル（self-chat）からグループとタスクを管理できます：
```
@Andy すべてのグループのスケジュールされたタスクを一覧表示
@Andy 月曜日のブリーフィングタスクを一時停止
@Andy 「家族チャット」グループに参加
```

## カスタマイズ

NanoClaw は設定ファイルを使いません。変更したい場合は Claude Code に伝えるだけです：

- 「トリガーワードを @Bob に変更」
- 「これからは応答を短く直接的に」
- 「おはようと言ったらカスタム挨拶を追加」
- 「会話の要約を毎週保存」

または `/customize` でガイド付き変更。

コードベースは小さいので Claude が安全に変更できます。

## コントリビューション

**機能を追加せず、スキルを追加してください。**

新しい機能（別のチャネル、MCP 統合、ワークフローなど）を追加したい場合、コアコードベースに追加する PR を作成しないでください。代わりに、NanoClaw を Fork し、ブランチでコード変更を行い、PR を開いてください。あなたのブランチを、他のユーザーが必要に応じて自分のフォークにマージできるスキルに変換します。

ユーザーは自分のフォークで `/add-<your-skill>` を実行するだけで、必要なものだけを正確に実行するクリーンなコードを手に入れます。

## 動作要件

- macOS、Linux、または Windows（WSL2 経由）
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- macOS：`sandbox-exec`（標準搭載）。Linux：`bubblewrap`（`apt install bubblewrap` / `dnf install bubblewrap`）。

## アーキテクチャ

```
Channels --> SQLite (メタデータ) + log.jsonl (メッセージ) --> ポーリングループ --> pi-coding-agent (プロセス内 + サンドボックス化された bash) --> 応答
```

単一の Node.js プロセス。Channel はスキル経由で追加され、起動時に自己登録します — オーケストレーターは認証情報が揃っているチャネルに接続します。エージェントは `@mariozechner/pi-coding-agent` を介してプロセス内で動作。bash コマンドは `sandbox-exec`（macOS）または `bubblewrap`（Linux）でラップされ、ルールは `config/sandbox.default.json` から（グループごとの上書き可能）。グループごとのメッセージキューと並行制御。

完全な移行設計は [docs/plans/2026-04-29-pi-mono-host-agent-design.md](docs/plans/2026-04-29-pi-mono-host-agent-design.md) を参照。

主要ファイル：
- `src/index.ts` - オーケストレーター：状態、メッセージループ、エージェント呼び出し
- `src/channels/registry.ts` - Channel レジストリ（起動時の自己登録）
- `src/channels/feishu.ts` - Feishu / Lark channel 実装
- `src/router.ts` - メッセージフォーマットとアウトバウンドルーティング
- `src/group-log.ts` - グループごとの `log.jsonl` 追加 / テール / カーソル
- `src/agent/run.ts` - プロセス内 pi-coding-agent ランタイムエントリ
- `src/agent/extension.ts` - NanoClaw IPC ツール（pi extension として）
- `src/agent/session-pool.ts` - グループごとの AgentSession プール（idle TTL あり）
- `src/agent/sandbox-config.ts` - サンドボックス設定ローダー
- `src/task-scheduler.ts` - スケジュールされたタスク
- `src/db.ts` - SQLite（scheduled_tasks / sessions / registered_groups / router_state）
- `groups/*/CLAUDE.md` - グループごとのメモリ
- `config/sandbox.default.json` - デフォルトサンドボックスプロファイル

## FAQ

**なぜコンテナを使わなくなったのか？**

NanoClaw は以前、エージェント呼び出しごとに Linux コンテナを起動していました。pi-mono 移行により、ホスト側実行 + bash の OS レベルサンドボックス化（macOS の `sandbox-exec`、Linux の `bubblewrap`）に切り替えました。高速で、メッセージごとのコールドスタートがなく、ファイルシステムとネットワーク分離は依然としてカーネルレベルです。

**Linux または Windows で動作しますか？**

はい。macOS は組み込みの `sandbox-exec` を使用。Linux は `bubblewrap` が必要（`apt install bubblewrap` / `dnf install bubblewrap`）。Windows は WSL2 経由（Linux パス）。`/setup` を実行するだけ。

**安全ですか？**

エージェントの bash コマンドは制限されたファイルシステムとネットワークアクセスを持つ OS レベルのサンドボックスで実行されます — `config/sandbox.default.json` で宣言的に定義され、グループごとに上書き可能。ルールを監査して厳しくできます。コードベースは小さく、サンドボックスがどう呼び出されるかを含む全攻撃面をレビューできます。

**設定ファイルがないのはなぜ？**

設定の氾濫を望まないからです。各ユーザーは汎用システムを設定するのではなく、コードが正確に望むことをするように NanoClaw をカスタマイズすべきです。設定ファイルが好きなら Claude に追加してもらえます。

**サードパーティ製またはオープンソースモデルを使えますか？**

はい。NanoClaw は provider 選択を `@mariozechner/pi-coding-agent` に委譲します。使いたいプロバイダーの標準環境変数を設定：

```bash
ANTHROPIC_API_KEY=...     # Anthropic
OPENAI_API_KEY=...        # OpenAI / OpenAI 互換（DeepSeek、Qwen など）
GEMINI_API_KEY=...        # Google Gemini
```

認証情報を `~/.pi/agent/auth.json` に保存することもできます。OpenAI 互換のローカルまたはセルフホストエンドポイントの場合、対応する pi-mono 環境変数（例：`OPENAI_BASE_URL`）でベース URL を上書きします。完全なプロバイダーリストは [pi-coding-agent docs](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) を参照。

**問題のデバッグはどうすればいいですか？**

Claude Code に聞いてください。「スケジューラーが動いていないのはなぜ？」「最近のログには何がある？」「このメッセージに応答がなかったのはなぜ？」これが NanoClaw の根底にある AI ネイティブアプローチです。

**セットアップが動かないのはなぜ？**

問題がある場合、セットアップ中に Claude が動的に修正しようとします。それでもうまくいかない場合は、`claude` を実行してから `/debug` を実行してください。Claude が他のユーザーに影響する可能性のある問題を見つけた場合、setup SKILL.md を変更する PR を開いてください。

**どのような変更がコードベースに受け入れられますか？**

セキュリティ修正、バグ修正、ベース設定への明確な改善のみ。それだけです。

その他すべて（新機能、OS 互換性、ハードウェアサポート、拡張）はスキルとして提供すべきです。

これによりベースシステムを最小限に保ち、各ユーザーが望まない機能を継承せずに自分のインストールをカスタマイズできます。

## コミュニティ

質問やアイデアは？[Discord に参加](https://discord.gg/VDdww8qS42)してください。

## 変更履歴

破壊的変更と移行手順は [CHANGELOG.md](CHANGELOG.md) を参照。完全なリリース履歴は [ドキュメントサイト](https://docs.nanoclaw.dev/changelog) を参照。

## ライセンス

MIT
