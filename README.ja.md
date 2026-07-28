<div align="center">
  <img src="https://raw.githubusercontent.com/kamihork/cckeep/main/assets/logo.png" width="140" height="140" alt="cckeep ロゴ(繋がったままのリンク)">

  <h1>cckeep</h1>

  <p><strong>Claude Code のリモートコントロールが黙って死ぬのを防ぎます。</strong><br>
  リモートコントロールは約31秒で再接続を諦め、二度と戻りません。<br>
  <code>cckeep</code> がそれを検知して繋ぎ直します。作業中のセッションには手を出しません。</p>

  <p>
    <a href="https://www.npmjs.com/package/cckeep"><img src="https://img.shields.io/npm/v/cckeep?color=1f9d8f&label=npm" alt="npm version"></a>
    <a href="https://www.npmjs.com/package/cckeep"><img src="https://img.shields.io/npm/dt/cckeep?color=3987e5" alt="npm downloads"></a>
    <a href="https://github.com/kamihork/cckeep/actions/workflows/test.yml"><img src="https://github.com/kamihork/cckeep/actions/workflows/test.yml/badge.svg" alt="test status"></a>
    <a href="LICENSE"><img src="https://img.shields.io/github/license/kamihork/cckeep?color=199e70" alt="license"></a>
  </p>

  <p><a href="https://kamihork.github.io/cckeep/">Website</a> | <a href="README.md">English</a> | 日本語</p>
</div>

## 何が問題か

[リモートコントロール](https://code.claude.com/docs/en/remote-control)は、手元で動いている Claude Code のセッションをスマホや claude.ai から操作する機能です。接続が切れても自動で再接続してくれますが、その回数は **1/2/4/8/16秒の間隔で5回まで**、合計 **31秒**しかありません。ノートを閉じる、Wi-Fi を切り替える、エレベーターに乗る。それだけで再試行は尽き、接続は閉じられて二度と戻りません。

壊れ方はもう一つあります。`/rc reconnecting` の表示のまま、いつまでも動かなくなるパターンです。これが [anthropics/claude-code#34255](https://github.com/anthropics/claude-code/issues/34255) で、2026年3月に報告されてから 👍 99件を集めたまま、まだ直っていません。

どちらの場合も、気づき方は同じです。スマホを開いたらセッションが消えている。そして公式に案内されている復旧方法は、机に戻って `/remote-control` と打つことだけです。

## クイックスタート

```sh
npm install -g cckeep
cckeep enable
```

`npm install` は CLI を `PATH` に置くだけで、この時点ではまだ何も動いていません。`cckeep enable` がバックグラウンドジョブを登録し(macOS は launchd、Linux は systemd user timer)、そこから15秒ごとに状態を確認して、切れているものを繋ぎ直すようになります。

`npx cckeep enable` ではなく、グローバルに入れてから実行してください。登録されたジョブはインストール先の cckeep をそのまま実行しますが、npx のキャッシュは使い捨てです。そこを指したジョブは、キャッシュが消された瞬間に何も言わず動かなくなります。監視ツールにとって、これがいちばん避けたい壊れ方です。そのため `cckeep enable` は npx のパスからの登録を拒否します。

入れる前に様子を見るだけなら `npx` で構いません。次の2つは何も変更しません。

```sh
npx cckeep            # いま何が見えているか
npx cckeep doctor     # tmux・ペイン・スケジューラの確認
```

**インストール直後に `command not found: cckeep` と出た場合**、shim 方式のバージョン管理ツールを使っているはずです。`nodenv` や `asdf` では、新しく入った実行ファイルが `PATH` に現れるまでに rehash が必要です。`nvm` の場合はシェルを開き直してください。

```sh
nodenv rehash      # nodenv
asdf reshim nodejs # asdf
# nvm: 新しいシェルを開くだけ
```

条件が一つあります。**Claude Code を tmux の中で動かすこと**です。素のターミナルで起動したセッションには、外のプロセスから入力を送る手段がありません。届く経路がない以上、どんなツールでも手が出せません。→ [tmux で Claude Code を動かす](#tmux-で-claude-code-を動かす)

> 机に戻る手間が省けたなら、⭐ を付けてもらえると同じ問題を抱えている人に届きやすくなります。

## 作業中のセッションには手を出しません

ここがこのツールの設計上いちばん難しいところです。タイマーでターミナルに文字を打ち込むツールは、「いま打っても安全か」を確実に判断できない限り、ただ危険なだけになります。以下はすべて実装済みで、[テスト](test/)で守られています。

- **ターンの実行中は打たない。** ペインを2秒あけて2回キャプチャします。実行中はスピナーとトークン数が動くので、2回が同じなら何もしていない証拠です。違っていれば手を出しません
- **ダイアログには打たない。** 権限プロンプトや選択メニューでは、Enter が「選択」になってしまいます。選択マーカーが画面にあれば、その回はまるごと見送ります
- **自分で開いたパネルには触らない。** `/remote-control` は QR コード付きのステータスパネルを開きます。cckeep が Enter を押すのは、自分でパネルを開いたときだけです
- **自分で切った接続は戻さない。** 一度でも接続できていたペインだけを対象にします。意図して切ったものは切れたままです
- **連打しない。** 同じペインに手を出すのは5分に1回までです
- **送る直前にもう一度確かめる。** 判断は1回のキャプチャで下しますが、待機したあとにもう一度確認します。その間に復帰していたり、ダイアログが出ていれば何も送りません

`--dry-run` を付けると、送る内容を表示するだけで実際には何も送りません。

## 何を見て判断しているか

| 画面の状態 | 意味 | cckeep の動作 |
|---|---|---|
| `/rc active` | 接続できている | ペインを覚えるだけ |
| `/rc reconnecting` | 31秒の再試行中 | 待つ(たいていはこれで戻る) |
| `/rc reconnecting` が2分以上 | 固まっている([#34255](https://github.com/anthropics/claude-code/issues/34255)) | パネルを開いて切断し、繋ぎ直す |
| `Remote Control disconnected` | 諦めた | すぐに繋ぎ直す |
| 表示なし(以前は出ていた) | 通知が流れて消えた | 4回続けて静かなら繋ぎ直す |
| 表示なし(一度も出ていない) | そもそも使っていない | 何もしない |

## コマンド

```
cckeep                 # 状態表示: Claude Code のペインごとに1行
cckeep watch           # スケジュール登録せずフォアグラウンドで実行
cckeep once            # 1回だけ実行(スケジューラが叩くもの)
cckeep enable          # バックグラウンドでの監視を開始
cckeep disable         # 監視を停止
cckeep doctor          # tmux・ペイン・スケジューラ・各パス
cckeep logs            # これまでの動作
```

オプション: `--dry-run`、`--json`、`--interval <秒>`、`--lang en|ja`(`LANG` から自動判定)。

`install` / `uninstall` は `enable` / `disable` のエイリアスとして引き続き使えます。

## tmux で Claude Code を動かす

cckeep は tmux のペインを読み、そこに入力します。動いている Claude Code セッションに外のプロセスから届く経路はこれしかなく、だからこそ tmux の中で起動しておく必要があります。プロセスを再起動すればいい、という話でもありません。それでは会話そのものが終わってしまい、守りたかったものを自分で失うことになります。

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
  if [ -n "$TMUX" ]; then command claude "$@"; return; fi
  if ! tmux has-session -t "=$session" 2>/dev/null; then
    tmux new-session -s "$session" -c "$PWD" claude "$@"; return
  fi

  # tmux セッションは中の claude より長生きするので、そのままアタッチすると
  # 会話が消えた素のシェルに落ちることがある。その場合は会話を呼び戻す。
  local pane_cmd cmd
  pane_cmd=$(tmux list-panes -t "=$session:" -F '#{pane_current_command}' 2>/dev/null | head -1)
  case "$pane_cmd" in
    zsh|bash|sh|fish)
      cmd="claude"
      case " $* " in
        *" -c "*|*" --continue "*|*" -r "*|*" --resume "*|*" --session-id "*) ;;
        *) cmd="$cmd --continue" ;;
      esac
      [ $# -gt 0 ] && cmd="$cmd $*"
      tmux send-keys -t "=$session:" "$cmd" C-m ;;
  esac
  tmux attach-session -t "=$session"
}
```

`cc -c` や `cc --continue` はそのまま使えます。フラグは Claude Code にそのまま渡ります。上のブロックが埋めているのは、フラグでは救えないケース、つまり tmux セッションだけが残って中の Claude Code が終了している状態です。

あわせて `~/.tmux.conf` に次の設定が必要です。これが無いと、tmux の中で Shift+Enter とデスクトップ通知が動かなくなります([公式の案内](https://code.claude.com/docs/en/terminal-config#configure-tmux))。

```sh
set -g allow-passthrough on
set -s extended-keys on
set -as terminal-features 'xterm*:extkeys'
```

Ctrl+B の衝突については何もしなくて構いません。Claude Code が tmux を検出して、自分のショートカットを `Ctrl+B Ctrl+B` に読み替えてくれます。

## 設定

デフォルト値は、動いていることに気づかない程度を狙って調整してあります。設定は `~/.cckeep/config.json`、環境変数、実行時フラグの順に上書きされます。設定ファイルが壊れている場合は、黙って一部だけ読み込むのではなくエラーで停止します。

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

- `interval`: 巡回する間隔(秒)。`enable` が登録する間隔でもあります
- `cooldown`: 同じペインに再び手を出せるようになるまでの秒数
- `stuckLimit`: `reconnecting` の表示が何回続いたら固まったとみなすか
- `missLimit`: 以前は表示があったペインが、何回続けて無表示なら繋ぎ直すか
- `settle`: 静止判定に使う2回のキャプチャの間隔(ミリ秒)。遅いマシンでは増やしてください
- `paneCommand`: Claude Code のペインだと判定するフォアグラウンドプロセス名

どの項目にも環境変数版があります。`CCKEEP_INTERVAL`、`CCKEEP_COOLDOWN`、`CCKEEP_STUCK_LIMIT`、`CCKEEP_MISS_LIMIT`、`CCKEEP_SETTLE`、`CCKEEP_PANE_COMMAND` です。`CCKEEP_HOME` を指定すれば、状態・設定・ログの置き場所を `~/.cckeep` 以外に移せます。

## 適用範囲

cckeep がするのは接続の張り直しだけです。Claude Code 側の再試行回数は**変えられません**。クローズドソースのバイナリに埋め込まれた定数なので、変えられるのは Anthropic だけです。[#34255](https://github.com/anthropics/claude-code/issues/34255) が修正されれば、このツールは要らなくなります。それがいちばん良い結末だと思っています。それまでは、ここに ⭐ を付けるより向こうに 👍 を付けるほうが役に立ちます。

設計上、以下は対象外です。

- **tmux の外のセッション**: 入力を送る経路がありません
- **VS Code 拡張**: ターミナル TUI ではないので、tmux で包めません
- **サーバーモード**(`claude remote-control`): 自分で起動したプロセスなので、launchd や systemd、あるいは `while true` ループで直接監督すれば済みます
- **10分を超える通信断**: Claude Code 自身がセッションを終了してしまうため、張り直す相手が残りません

## プライバシー

cckeep は接続状態を判定するために、tmux ペインに表示されているテキストを読みます。それはあなたの会話そのものです。そのため、次のようにしています。

- すべてローカルで完結し、このパッケージにネットワークコードはありません
- テレメトリなし、アカウントなし、外部送信なし
- ペインのテキストは数個の判定文字列と照合したあとすぐ破棄します。ログに残るのはペイン名と判定結果だけです
- ログの場所は `~/.cckeep/cckeep.log` です。`cckeep logs` で表示できます

## 仕組み

Claude Code はフッターにリモートコントロールの状態を表示します。接続中は `/rc active`、再試行中は `/rc reconnecting`、諦めたときは `Remote Control disconnected` という通知です。cckeep はフォアグラウンドプロセスが `claude` のペインを tmux に問い合わせ、`tmux capture-pane` の出力からこれらを読み取ります。ペインごとの小さなカウンタは `~/.cckeep/state.json` に保存します。

判定層(`src/detect.js`)は、画面テキストと直前の状態だけを受け取る純粋関数です。だからこそ、安全ルールをターミナル無しで網羅的にテストできます。静止判定・直前の再確認・キー送信といった I/O は、実行層(`src/run.js`)が担当します。

これらは公開 API ではありません。判定に使っている文字列は UI のテキストなので、いつ変わってもおかしくありません。変わったとき cckeep は誤動作ではなく沈黙します。読めなくなったペインは「一度も接続していない」ように見え、接続を見たことがないペインには決して手を出さないからです。

## 開発

```sh
git clone https://github.com/kamihork/cckeep.git && cd cckeep
npm test                       # ネットワークも tmux も不要
node bin/cckeep.js doctor
```

テストは tmux をフェイクするので、どんな環境でも走ります。コントリビューションは歓迎です。特に、検出が漏れてしまう Claude Code のバージョンやターミナルでの実際の表示文字列を教えてもらえると助かります。詳しくは [CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。

## ライセンス

[MIT](LICENSE) © [kamihork](https://github.com/kamihork)
