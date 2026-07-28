<div align="center">
  <img src="https://raw.githubusercontent.com/kamihork/cckeep/main/assets/logo.png" width="140" height="140" alt="cckeep ロゴ — 開いたまま保たれるリンク">

  <h1>cckeep</h1>

  <p><strong>Claude Code のリモートコントロールが黙って死ぬのを防ぎます。</strong><br>
  リモートコントロールは約31秒で再試行を諦め、二度と戻りません。<br>
  <code>cckeep</code> はそれを検知して繋ぎ直します — 作業中のセッションには触れずに。</p>

  <p>
    <a href="https://www.npmjs.com/package/cckeep"><img src="https://img.shields.io/npm/v/cckeep?color=1f9d8f&label=npm" alt="npm version"></a>
    <a href="https://www.npmjs.com/package/cckeep"><img src="https://img.shields.io/npm/dt/cckeep?color=3987e5" alt="npm downloads"></a>
    <a href="https://github.com/kamihork/cckeep/actions/workflows/test.yml"><img src="https://github.com/kamihork/cckeep/actions/workflows/test.yml/badge.svg" alt="test status"></a>
    <a href="LICENSE"><img src="https://img.shields.io/github/license/kamihork/cckeep?color=199e70" alt="license"></a>
  </p>

  <p><a href="https://kamihork.github.io/cckeep/">Website</a> | <a href="README.md">English</a> | 日本語</p>
</div>

## 何が問題か

[リモートコントロール](https://code.claude.com/docs/en/remote-control)は、手元で動いている Claude Code のセッションをスマホや claude.ai から操作する機能です。接続が切れても自動で再接続してくれます — ただし **1/2/4/8/16秒のバックオフで5回まで**。合計 **31秒** の予算です。ノートを閉じる、Wi-Fi を切り替える、エレベーターに乗る。それだけで予算は尽き、接続は閉じられて二度と戻りません。

もう一つの壊れ方もあります。`/rc reconnecting` の表示のまま永久に固まるパターンで、これが [anthropics/claude-code#34255](https://github.com/anthropics/claude-code/issues/34255) — 2026年3月から open、👍 99件、未修正です。

どちらにせよ気づき方は同じです。スマホを開いたらセッションが消えている。公式に案内されている復旧方法は、机に戻って `/remote-control` と打つことです。

## クイックスタート

```sh
npm install -g cckeep
cckeep install
```

バックグラウンドジョブを登録します(macOS は launchd、Linux は systemd user timer)。15秒ごとに確認し、死んでいるものを繋ぎ直します。

`npx cckeep install` ではなくグローバルに入れてください。登録されたジョブはインストール先の cckeep を実行しますが、npx のキャッシュは使い捨てです。そこを指すジョブはキャッシュが消された瞬間に、黙って動かなくなります — 監視ツールが持ってはいけない唯一の壊れ方です。そのため `cckeep install` は npx のパスからの登録を拒否します。

入れる前に様子を見るだけなら `npx` で構いません。以下の2つは何も変更しません。

```sh
npx cckeep            # いま何が見えているか
npx cckeep doctor     # tmux・ペイン・スケジューラの確認
```

**インストール直後に `command not found: cckeep` と出たら**、shim 方式のバージョン管理ツールを使っています。`nodenv` や `asdf` は新しく入った実行ファイルを PATH に出すのに rehash が必要で、`nvm` はシェルを開き直す必要があります。

```sh
nodenv rehash      # nodenv
asdf reshim nodejs # asdf
# nvm: 新しいシェルを開くだけ
```

条件が一つあります。**Claude Code が tmux の中で動いていること。** 素のターミナルで起動したセッションには別プロセスから入力を送る手段がなく、どんなツールでも手が出せません。→ [tmux で Claude Code を動かす](#tmux-で-claude-code-を動かす)

> 机に戻る手間が省けたなら、⭐ が同じ問題を抱えている人に届く助けになります。

## 作業中のセッションには打ち込みません

これが設計上の核心です。タイマーでターミナルに文字を打ち込むツールは、「いま安全か」を確実に判断できない限り危険物でしかありません。以下はすべて実装され、[テスト](test/)されています。

- **ターン実行中は絶対に打たない。** ペインを2秒あけて2回キャプチャします。実行中はスピナーとトークンカウンタが動くので、2回が一致すれば何も起きていない証拠、違えば手を出さない
- **ダイアログには打たない。** 権限プロンプトや選択メニューでは Enter が「選択」になります。選択マーカーが画面にあれば、その回はスキップ
- **あなたが開いたパネルには打たない。** `/remote-control` は QR コード付きのステータスパネルを開きます。cckeep が Enter を押すのは、自分で開いたときだけ
- **自分で切ったセッションは戻さない。** 一度でも接続済みだったペインだけを追跡します。意図的に切ったものは切れたまま
- **連打しない。** 1ペインにつき5分に1回まで
- **直前に再確認する。** 判断は1回のキャプチャで下し、待機後にもう一度確認します。その間に復帰したりダイアログが出ていれば、何も送りません

`--dry-run` を付けると、何をするつもりかだけを表示して一切送信しません。

## 何を見ているか

| 画面の状態 | 意味 | cckeep の動作 |
|---|---|---|
| `/rc active` | 接続中 | ペインを記憶するだけ |
| `/rc reconnecting` | 31秒の予算内 | 待つ(たいていこれで直る) |
| `/rc reconnecting` が2分継続 | 固着([#34255](https://github.com/anthropics/claude-code/issues/34255)) | パネルを開いて切断し、張り直す |
| `Remote Control disconnected` | 諦めた | 即座に繋ぎ直す |
| 表示なし(以前はあった) | 通知が流れて消えた | 4回静かなら繋ぎ直す |
| 表示なし(一度もなかった) | そういう使い方ではない | 何もしない |

## コマンド

```
cckeep                 # 状態表示: Claude Code のペインごとに1行
cckeep watch           # スケジュール登録せずフォアグラウンドで実行
cckeep once            # 1回だけ実行(スケジューラが叩くもの)
cckeep install         # バックグラウンドジョブを登録
cckeep uninstall       # 解除
cckeep doctor          # tmux・ペイン・スケジューラ・各パス
cckeep logs            # これまでの動作
```

オプション: `--dry-run`、`--json`、`--interval <秒>`、`--lang en|ja`(`LANG` から自動判定)。

## tmux で Claude Code を動かす

cckeep は tmux ペインを読み、そこに入力します。動いている Claude Code セッションに別プロセスから届く経路はこれだけで、だからこそ tmux 内での起動が必要です。プロセスの再起動は代替になりません — 会話が終わってしまい、守りたかったものそのものを失うからです。

最小の変更は、対話起動だけを包むシェル関数です。`claude update` や `claude doctor`、`claude -p` はそのまま素通しします。

```sh
cc() {
  local a
  for a in "$@"; do
    case "$a" in
      -p|--print|-v|--version|-h|--help|--bg|--background|--output-format) command claude "$@"; return ;;
      agents|auth|doctor|install|mcp|plugin|project|setup-token|update|upgrade|remote-control|rc|config)
        command claude "$@"; return ;;
      -*) ;;
      *) break ;;
    esac
  done
  local session="claude-$(basename "$PWD")-$(printf '%s' "$PWD" | cksum | cut -d' ' -f1)"
  if [ -n "$TMUX" ]; then command claude "$@"
  elif tmux has-session -t "=$session" 2>/dev/null; then tmux attach-session -t "=$session"
  else tmux new-session -s "$session" -c "$PWD" claude "$@"
  fi
}
```

あわせて `~/.tmux.conf` に2行必要です。これが無いと tmux 内で Shift+Enter とデスクトップ通知が壊れます([公式の案内](https://code.claude.com/docs/en/terminal-config#configure-tmux))。

```sh
set -g allow-passthrough on
set -s extended-keys on
set -as terminal-features 'xterm*:extkeys'
```

Ctrl+B の衝突は対処不要です。Claude Code は tmux を検出して、自身のショートカットを `Ctrl+B Ctrl+B` に読み替えます。

## 設定

デフォルトは「存在に気づかない」ことを狙って調整してあります。`~/.cckeep/config.json`、環境変数、実行時フラグの順で上書きされます。壊れた設定ファイルは黙って一部だけ読むのではなく、エラーで停止します。

```json
{
  "interval": 15,
  "cooldown": 300,
  "stuckLimit": 8,
  "missLimit": 4,
  "settle": 2000,
  "paneCommand": "claude"
}
```

- `interval` — 巡回間隔(秒)。`install` が登録する間隔でもある
- `cooldown` — 同じペインに再度手を出せるまでの秒数
- `stuckLimit` — `reconnecting` が何回続いたら固着とみなすか
- `missLimit` — 表示のあったペインが何回無表示なら繋ぎ直すか
- `settle` — 静止判定の2回のキャプチャ間隔(ミリ秒)。遅いマシンでは増やす
- `paneCommand` — Claude Code のペインと判定するフォアグラウンドプロセス名

すべてに環境変数版があります: `CCKEEP_INTERVAL`、`CCKEEP_COOLDOWN`、`CCKEEP_STUCK_LIMIT`、`CCKEEP_MISS_LIMIT`、`CCKEEP_SETTLE`、`CCKEEP_PANE_COMMAND`。`CCKEEP_HOME` で状態・設定・ログの置き場所を `~/.cckeep` から移せます。

## 適用範囲

cckeep がするのは接続の張り直しだけです。Claude Code の再試行予算そのものは**変えません** — クローズドソースのバイナリ内の定数であり、変えられるのは Anthropic だけです。[#34255](https://github.com/anthropics/claude-code/issues/34255) が修正されればこのツールは不要になります。それが正しい結末です。それまでは、ここに star を付けるより向こうに 👍 を付けるほうが価値があります。

設計上、以下は対象外です。

- **tmux 外のセッション** — 入力を送る経路がない
- **VS Code 拡張** — ターミナル TUI ではなく、tmux で包めない
- **サーバーモード**(`claude remote-control`)— 自分が起動したプロセスなので、launchd/systemd や `while true` ループで直接監督すればよい
- **10分を超える通信断** — Claude Code 自身がセッションを終了するため、張り直す対象が残らない

## プライバシー

cckeep は接続状態を判定するために tmux ペインの表示テキストを読みます。それはあなたの会話です。したがって:

- すべてローカルで完結し、このパッケージにネットワークコードはありません
- テレメトリなし、アカウントなし、外部送信なし
- ペインのテキストは数個の判定文字列と照合した後すぐ破棄され、ログに残るのはペイン名と判定結果だけです
- ログは `~/.cckeep/cckeep.log`。`cckeep logs` で表示できます

## 仕組み

Claude Code はフッターにリモートコントロールの状態を描画します。接続中は `/rc active`、再試行中は `/rc reconnecting`、諦めたときは `Remote Control disconnected` の通知です。cckeep は tmux にフォアグラウンドプロセスが `claude` のペインを問い合わせ、`tmux capture-pane` からこれらを読み取り、ペインごとの小さなカウンタを `~/.cckeep/state.json` に保持します。

判定層(`src/detect.js`)は画面テキストと直前の状態だけを引数に取る純粋関数です。だからこそ安全ルールをターミナル無しで網羅的にテストできます。I/O は実行層(`src/run.js`)が担当します — 静止判定、直前の再確認、キー送信です。

これらは公開 API ではありません。判定文字列は UI テキストであり変わり得ます。変わったとき cckeep は誤動作ではなく沈黙します — 読めないペインは「一度も接続していない」ように見え、接続を見たことがないペインには決して手を出さないためです。

## 開発

```sh
git clone https://github.com/kamihork/cckeep.git && cd cckeep
npm test                       # 36テスト。ネットワークも tmux も不要
node bin/cckeep.js doctor
```

テストは tmux をフェイクするのでどこでも走ります。コントリビューション歓迎です — 特に、検出が漏れる Claude Code のバージョンやターミナルでの実際の表示文字列が助かります。[CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。

## ライセンス

[MIT](LICENSE) © [kamihork](https://github.com/kamihork)
