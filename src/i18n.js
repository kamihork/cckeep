const en = {
  noTmux: 'tmux not found. cckeep reads and types into tmux panes, so tmux is required.',
  noServer: 'No tmux server is running — nothing to watch.',
  noPanes: 'No tmux pane is running Claude Code.',
  hintOutside: 'Claude Code started outside tmux cannot be reached: there is no way to type into it from another process.',
  connected: 'connected',
  retrying: 'retrying',
  waiting: 'no indicator',
  neverConnected: 'no indicator seen yet',
  dialog: 'dialog open',
  cooldown: 'cooling down',
  busy: 'busy',
  composerBusy: 'something typed in the box',
  recovered: 'recovered',
  rearmed: 're-armed',
  confirmed: 'bridge cycled',
  wouldRearm: 'would re-arm',
  wouldConfirm: 'would cycle bridge',
  watching: (n) => `Watching every ${n}s. Ctrl+C to stop.`,
  enabled: (kind, path) => `Enabled (${kind}): ${path}`,
  enableFailed: (kind) => `Wrote the ${kind} unit, but could not load it. Load it manually, or run \`cckeep watch\` in a terminal.`,
  disabled: (kind) => `Disabled — removed the ${kind} job.`,
  unsupported: 'Automatic scheduling supports macOS (launchd) and Linux (systemd user timers). Elsewhere, run `cckeep watch` under your own supervisor.',
  ephemeral: (p) => `Refusing to schedule: this copy of cckeep lives in npm's throwaway npx cache\n  ${p}\nA scheduled job pointing there stops working the moment the cache is cleared — silently. Install it properly first:\n\n  npm install -g cckeep && cckeep enable\n`,
  scheduledPath: 'scheduled cmd',
  scheduledMissing: 'MISSING — run `cckeep enable` again',
  noLog: 'No log yet.',
  doctorOk: 'ok',
  doctorFail: 'missing',
  nudge: [
    '',
    '  cckeep re-armed a session for you. If that saved you a walk back to your desk:',
    '    \u2b50 https://github.com/kamihork/cckeep',
    '    \ud83d\udc4d https://github.com/anthropics/claude-code/issues/34255  (the upstream bug \u2014 worth more than a star)',
    '',
  ].join('\n'),
};

const ja = {
  noTmux: 'tmux が見つかりません。cckeep は tmux のペインを読んで入力するので、tmux が必要です。',
  noServer: 'tmux が起動していないので、監視するものがありません。',
  noPanes: 'Claude Code が動いている tmux ペインが見つかりません。',
  hintOutside: 'tmux の外で起動した Claude Code には手が出せません。外のプロセスから入力を送る経路がないためです。',
  connected: '接続中',
  retrying: '再試行中',
  waiting: '表示なし',
  neverConnected: '接続表示は未確認',
  dialog: 'ダイアログが開いている',
  cooldown: '待機中(連打防止)',
  busy: '実行中のためスキップ',
  composerBusy: '入力欄に文字があるため見送り',
  recovered: '自力で復帰',
  rearmed: '繋ぎ直しました',
  confirmed: '接続を張り直しました',
  wouldRearm: '繋ぎ直します',
  wouldConfirm: '接続を張り直します',
  watching: (n) => `${n} 秒ごとに確認します。止めるときは Ctrl+C。`,
  enabled: (kind, path) => `有効にしました(${kind})。定義ファイル: ${path}`,
  enableFailed: (kind) => `${kind} の定義ファイルは作成しましたが、読み込みに失敗しました。手動で読み込むか、ターミナルで \`cckeep watch\` を動かしてください。`,
  disabled: (kind) => `無効にしました。${kind} のジョブを削除しています。`,
  unsupported: '自動登録に対応しているのは macOS(launchd)と Linux(systemd user timer)です。それ以外の環境では、`cckeep watch` をお使いの常駐手段で動かしてください。',
  ephemeral: (p) => `登録を中止しました。この cckeep は npm の使い捨てキャッシュ(npx)の中にあります。\n  ${p}\nここを指すジョブは、キャッシュが消えた瞬間に何も言わず動かなくなります。先にグローバルへインストールしてください。\n\n  npm install -g cckeep && cckeep enable\n`,
  scheduledPath: '登録先',
  scheduledMissing: '見つかりません(`cckeep enable` を実行し直してください)',
  noLog: 'まだログはありません。',
  doctorOk: 'ok',
  doctorFail: '見つかりません',
  nudge: [
    '',
    '  cckeep がセッションを繋ぎ直しました。机に戻る手間が省けたなら:',
    '    \u2b50 https://github.com/kamihork/cckeep',
    '    \ud83d\udc4d https://github.com/anthropics/claude-code/issues/34255 (本家の不具合。star より効きます)',
    '',
  ].join('\n'),
};

export function pickLang(explicit) {
  if (explicit === 'en' || explicit === 'ja') return explicit;
  const env = process.env.CCKEEP_LANG || process.env.LC_ALL || process.env.LANG || '';
  return /^ja/i.test(env) ? 'ja' : 'en';
}

export function strings(lang) {
  return lang === 'ja' ? ja : en;
}
