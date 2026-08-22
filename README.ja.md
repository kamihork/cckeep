<div align="center">
  <img src="https://raw.githubusercontent.com/kamihork/cckeep/main/assets/logo.png" width="140" height="140" alt="cckeep ロゴ(繋がったままのリンク)">

  <h1>cckeep</h1>

  <p><strong>Claude Code のリモートコントロールが黙って死ぬのを防ぎます。</strong><br>
  切断の中には、今も机に戻って <code>/remote-control</code> と打つしかないものがあります。<br>
  <code>cckeep</code> がそれを検知して繋ぎ直します。作業中のセッションには手を出しません。</p>

  <p>
    <a href="https://www.npmjs.com/package/cckeep"><img src="https://img.shields.io/npm/v/cckeep?color=1f9d8f&label=npm" alt="npm version"></a>
    <a href="https://www.npmjs.com/package/cckeep"><img src="https://img.shields.io/npm/dt/cckeep?color=3987e5" alt="npm downloads"></a>
    <a href="https://github.com/kamihork/cckeep/actions/workflows/test.yml"><img src="https://github.com/kamihork/cckeep/actions/workflows/test.yml/badge.svg" alt="test status"></a>
    <a href="LICENSE"><img src="https://img.shields.io/github/license/kamihork/cckeep?color=199e70" alt="license"></a>
  </p>

  <p><a href="https://kamihork.github.io/cckeep/">Website</a> | <a href="README.md">English</a> | 日本語</p>
</div>

> **cckeep が最初に狙っていた不具合は、Claude Code 2.1.232(2026年8月)で修正されました。** リモートコントロールが31秒で諦めることはもうありません。今は約30分にわたって自力で再接続を続けます。手を貸す必要が残っている範囲は以前より狭く、それが何かは[何が問題か](#何が問題か)に書いてあります。

<p align="center">
  <img src="https://raw.githubusercontent.com/kamihork/cckeep/main/assets/demo.gif" width="880" alt="切断されたリモートコントロールを cckeep が検知して繋ぎ直すところ">
</p>

## 何が問題か

[リモートコントロール](https://code.claude.com/docs/en/remote-control)は、手元で動いている Claude Code のセッションをスマホや claude.ai から操作する機能です。以前は接続が切れると **1/2/4/8/16秒の間隔で5回、合計31秒**で再試行を使い切っていました。ノートを閉じる、Wi-Fi を切り替える、エレベーターに乗る。それだけで接続は閉じられ、二度と戻りませんでした。これは Claude Code **2.1.232** で修正されています。今は瞬断のあと約30分にわたって再接続を続け、ネットワーク障害中は復旧するまで再試行します。この不具合のために来られたのであれば、もう cckeep は必要ありません。それでいいと思います。

2.1.232 でも変わらなかったのは、接続が閉じられたまま手作業が残る切断です。

- **presence heartbeat が失敗し続ける場合。** 接続自体は生きているのに、セッションの heartbeat だけが通らない状態です。Claude Code は約30分ほど再登録を試みたのち、`could not reach the Remote Control server for about 30 minutes` と表示して切断します。[案内されている復旧方法は `/remote-control` を実行することだけです。](https://code.claude.com/docs/en/remote-control#limitations)
- **HTTP 403 が3分を超えて続く場合。** VPN やネットワークの切り替えで、間に入った何かが 403 を返すようになった状態です。Claude Code は3分まで耐えたあと切断し、何が拒否したのかを表示します。自力では戻りません。
- **固まる場合。** `/rc reconnecting` の表示のまま動かなくなります。これが [anthropics/claude-code#34255](https://github.com/anthropics/claude-code/issues/34255) で、2026年3月に報告されてから 👍 99件を集めています。2.1.232 で作り直された再接続の経路でも再現するかは未確認です。cckeep は[35分](#設定)待ってからでないとこれと判定しないので、時間はかかっていても成功する再接続を途中で切ることはありません。

さらに、接続とは無関係な止まり方がもう一つあります。セッションが使っていた[枠を使い切った](#使用量の上限任意で有効化)場合です。Claude Code はバナーを表示して停止します。枠が回復したときに作業を再開してくれるバージョンは存在しません。

どれも気づき方は同じです。スマホを開いたら、セッションがそこにいない。cckeep が代わりに気づいて、繋ぎ直します。

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

- **入力中の文字の上には打たない。** Enter は入力欄の内容をそのまま送信するので、書きかけの下書きがあるとコマンドがくっついて送信されてしまいます。入力欄に何か入っている場合、そもそも入力欄が見つからない場合は何も送りません。静止判定ではこれを防げません。下書きは動かないからです
- **ターンの実行中は打たない。** ペインを3回キャプチャします。実行中はスピナーとトークン数が動くので、3回とも同じなら何もしていない証拠です。2回ではなく3回、しかも間隔をあえて半端な値にしているのは、周期が間隔を割り切るアニメーションだと同じ絵が並んで静止に見えてしまうためです
- **ダイアログには打たない。** 権限プロンプトでは Enter が「選択」になります。選択マーカーは画面のどこにあっても対象にしますが、英語の言い回し(`Do you want …` など)は入力欄の近くにある場合だけ対象にします。Claude Code は通常の返答でも同じ言い回しを使うためです
- **自分で開いたパネルには触らない。** `/remote-control` は QR コード付きのステータスパネルを開きます。cckeep が Enter を押すのは自分でパネルを開いたときだけで、押す直前にもパネルがまだ開いているかを確認します
- **話題に出しただけのセッションは対象にしない。** 状態の判定は画面末尾の数行だけから読み、会話本文からは読みません。`/rc active` について話しているセッションが接続中と誤認されることはありません。一度も接続を確認していないペインに手を出すのは、Claude Code 自身が「接続が切れた」と表示した場合だけです
- **連打しない。同時に2つ動かない。** 同じペインに手を出すのは5分に1回まで。さらにロックを取るので、`cckeep watch` とスケジュール実行が並走しても、2つの処理が混ざって壊れた入力になることはありません
- **無理なものには挑まない。** 「Remote Control requires a claude.ai subscription」のような応答は、認証やプランの問題でありコマンドでは直せません。この場合そのペインの追跡をやめ、接続が回復したのを見るまで手を出しません。未知の失敗に対しても1回の障害につき再接続は最大3回までで、それ以上は打ち直しを繰り返さず、回復を確認できるまで待ちます
- **送る直前にもう一度確かめる。** 判断は1回のキャプチャで下しますが、待機後にもう一度確認します。その間に復帰した、ダイアログが出た、何か入力された — いずれでも何も送りません。そしてそれまでの経過はリセットせず保持します

`--dry-run` を付けると、送る内容を表示するだけで実際には何も送りません。

## 何を見て判断しているか

| 画面の状態 | 意味 | cckeep の動作 |
|---|---|---|
| `/rc active`、または切り詰められた `/rc` | 接続できている | ペインを覚えるだけ |
| `/rc reconnecting` | Claude Code が再接続中(約30分の猶予がある) | 待つ(2.1.232 で確実に戻るようになった範囲) |
| `/rc reconnecting` が35分以上 | Claude Code 自身の猶予を超えた。固まっている([#34255](https://github.com/anthropics/claude-code/issues/34255))か、障害がまだ続いているか | パネルを開いて切断し、繋ぎ直す |
| `Remote Control disconnected` | 諦めた | すぐに繋ぎ直す |
| 表示なし(以前は出ていた) | 通知が流れて消えた | 4回続けて静かなら繋ぎ直す |
| 表示なし(一度も出ていない) | そもそも使っていない | 何もしない |

## 使用量の上限(任意で有効化)

セッションは接続とは無関係な理由でも止まります。使っていた枠の上限に達した場合です。Claude Code はバナーを出して停止し、戻ってきた時もそのまま止まっています。

`"limits": true` で有効になります。接続表示と同じ要領でバナーを読み、解除を待ってから `limitResumePrompt` を送って作業を再開させます。セッション枠・週間枠・特定モデルの枠のいずれであっても扱いは同じです。どれも待つ以外に短くする手段がないためです。

その待ち時間はバックオフ(15分から始めて倍々、上限2時間)であって、バナーの `· resets 3pm` を読んだ結果ではありません。あの時刻表示は人間向けに整形された文字列で、読み違える実装は「何時間も長く眠る」か「同じ壁に突っ込み直す」かのどちらかになります。バックオフなら自己補正が効きます。早すぎた再開は失敗し、バナーがまた出て、次の待ち時間が倍になるだけです。`limitMaxAttempts` を超えたら打ち切って、あとは手動に委ねます。

既定値では、7時間45分かけて6回試み、9時間45分で打ち切ります。5時間のセッション枠は跨げますが、**週間枠は跨げません**。週間枠も待たせたい場合は `limitMaxAttempts` と `limitBackoff` を引き上げてください。1週間にわたって1日1回ペインに入力し続けるツールと、夕食前に諦めるツールは別物なので、その匙加減は設定する側に委ねています。

既定で無効なのは、繋ぎ直しと違ってこれが**会話に1文を打ち込む**動作だからです。その1文は `limitResumePrompt` なので、好きな文面にしてください。

`limits` の対象は Claude Code が動いている**すべてのペイン**です。Remote Control 側が意図的に手を出さないペイン(接続表示を一度も出していないセッションは「こちらから勝手に有効化するものではない」と判断される)も含みます。上限からの復旧はその区別をしません。

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
  "stuckLimit": 140,
  "missLimit": 4,
  "settle": 2000,
  "paneCommand": "claude",
  "limits": false
}
```

- `interval`: 巡回する間隔(秒)。`enable` が登録する間隔でもあります
- `cooldown`: 同じペインに再び手を出せるようになるまでの秒数
- `stuckLimit`: `reconnecting` の表示が何回続いたら固まったとみなすか。`interval` を掛けた値が実時間になるので、既定では35分です。Claude Code 自身が自力で再接続を続ける約30分より必ず長くしてください。短いと、戻ってくるはずの接続を cckeep が切ってしまいます。**0.7.0 より前から使っている場合**、`config.json` に `8` が書かれていると2分のままなので、上げてください
- `missLimit`: 以前は表示があったペインが、何回続けて無表示なら繋ぎ直すか
- `maxRearms`: 1回の障害につき何回まで繋ぎ直しを試みるか。超えたら回復を見るまで打ち切り
- `settle`: 静止判定に使う3回のキャプチャの間隔(ミリ秒)。遅いマシンでは増やしてください
- `paneCommand`: Claude Code のペインだと判定するフォアグラウンドプロセス名
- `tmuxSocket`: 既定以外のサーバーで tmux を動かしている場合のソケット名またはパス(`tmux -L name` / `-S path`)。空なら既定サーバー
- `tmuxBinary`: tmux が通常の探索先に無い場合の絶対パス

[使用量の上限](#使用量の上限任意で有効化)まわり:

- `limits`: 上限バナーに反応するかどうか。既定は無効
- `limitBackoff`: 最初の再開までの秒数。うまくいかないたびに倍になります
- `limitMaxAttempts`: 1回の上限につき何回まで再開を試みるか
- `limitResumePrompt`: 作業を再開させるために打ち込む文面

どの項目にも環境変数版があります。`CCKEEP_INTERVAL`、`CCKEEP_COOLDOWN`、`CCKEEP_STUCK_LIMIT`、`CCKEEP_MISS_LIMIT`、`CCKEEP_MAX_REARMS`、`CCKEEP_SETTLE`、`CCKEEP_PANE_COMMAND`、`CCKEEP_TMUX_SOCKET`、`CCKEEP_TMUX`、`CCKEEP_LIMITS`、`CCKEEP_LIMIT_BACKOFF`、`CCKEEP_LIMIT_MAX_ATTEMPTS`、`CCKEEP_LIMIT_RESUME_PROMPT` です。`cckeep enable` を実行した時点で設定されている値はスケジュールされたジョブにも書き込まれるので、シェルでだけ設定したソケットがバックグラウンド実行から抜け落ちることはありません。`CCKEEP_HOME` を指定すれば、状態・設定・ログの置き場所を `~/.cckeep` 以外に移せます。

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
- ログの場所は `~/.cckeep/cckeep.log` で、512KB を超えると1世代だけ残してローテーションします。`cckeep logs` で直近の行を表示できます

## 仕組み

Claude Code はフッターにリモートコントロールの状態を表示します。接続中は `/rc active`、再試行中は `/rc reconnecting`、諦めたときは `Remote Control disconnected` という通知です。cckeep は Claude Code が動いているペインを探し、`tmux capture-pane` の出力からこれらを読み取ります。ペインごとの小さなカウンタは `~/.cckeep/state.json` に保存します。

ペインを探すところに一手間あります。Claude Code は自身のプロセスタイトルを書き換えるため、tmux はそのペインのコマンド名を `claude` ではなく `2.1.220` のように報告します。tmux の報告する名前だけで判定すると、実機では1つも見つかりません。そこで cckeep はプロセステーブルも参照し、ペインのプロセス(またはそこから起動されたプロセス)が実際に `claude` であればそのペインを対象とします。

インジケータは右寄せで描画されるため、カスタムステータスラインを使っていたりペインが狭かったりすると、`active` が削られて `/rc` だけになります。cckeep はこれを接続中として扱います。インジケータ自体は接続がある間しか描画されず、接続中と読んでもペインを記録して待つだけなので、안全な側に倒れるからです。

「どこを見るか」も同じくらい重要です。状態の判定に使う文字列は画面末尾の十数行からしか読みません。これらの言葉は普通の会話にも出てくるので、たとえば `/rc active` について話しているだけのセッションが「接続中」に見えてしまうからです。逆にダイアログとステータスパネルの検出は画面全体を対象にしています。こちらは誤検知しても1回見送るだけで済みますが、見落とすと誤ったキー入力に直結します。

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
