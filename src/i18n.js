const en = {
  noTmux: 'tmux not found. cckeep reads and types into tmux panes, so tmux is required.',
  noServer: 'No tmux server is running — nothing to watch.',
  noPanes: 'No tmux pane is running Claude Code.',
  hintOutside: 'Claude Code started outside tmux cannot be reached: there is no way to type into it from another process.',
  header: 'pane          state          detail',
  connected: 'connected',
  retrying: 'retrying',
  waiting: 'no indicator',
  neverConnected: 'not connected',
  dialog: 'dialog open',
  cooldown: 'cooling down',
  busy: 'busy',
  recovered: 'recovered',
  rearmed: 're-armed',
  confirmed: 'bridge cycled',
  wouldRearm: 'would re-arm',
  wouldConfirm: 'would cycle bridge',
  watching: (n) => `Watching every ${n}s. Ctrl+C to stop.`,
  installed: (kind, path) => `Installed (${kind}): ${path}`,
  installFailed: (kind) => `Wrote the ${kind} unit, but could not load it. Load it manually, or run \`cckeep watch\` in a terminal.`,
  uninstalled: (kind) => `Removed the ${kind} job.`,
  unsupported: 'Automatic scheduling supports macOS (launchd) and Linux (systemd user timers). Elsewhere, run `cckeep watch` under your own supervisor.',
  noLog: 'No log yet.',
  doctorOk: 'ok',
  doctorFail: 'missing',
};

const ja = {
  noTmux: 'tmux が見つかりません。cckeep は tmux のペインを読んで入力するため、tmux が必須です。',
  noServer: 'tmux サーバーが起動していません。監視対象がありません。',
  noPanes: 'Claude Code が動いている tmux ペインがありません。',
  hintOutside: 'tmux の外で起動した Claude Code には届きません。別プロセスから入力を送る手段がないためです。',
  header: 'ペイン        状態           詳細',
  connected: '接続中',
  retrying: '再試行中',
  waiting: '表示なし',
  neverConnected: '未接続',
  dialog: 'ダイアログ表示中',
  cooldown: 'クールダウン中',
  busy: '実行中',
  recovered: '復帰済み',
  rearmed: '再接続を送信',
  confirmed: 'ブリッジを張り直し',
  wouldRearm: '再接続を送信する',
  wouldConfirm: 'ブリッジを張り直す',
  watching: (n) => `${n} 秒ごとに監視します。Ctrl+C で停止。`,
  installed: (kind, path) => `登録しました (${kind}): ${path}`,
  installFailed: (kind) => `${kind} の定義は書きましたが、読み込みに失敗しました。手動で読み込むか、ターミナルで \`cckeep watch\` を実行してください。`,
  uninstalled: (kind) => `${kind} のジョブを削除しました。`,
  unsupported: '自動スケジュール登録は macOS (launchd) と Linux (systemd user timer) に対応しています。それ以外では `cckeep watch` を任意の常駐手段で動かしてください。',
  noLog: 'ログはまだありません。',
  doctorOk: 'ok',
  doctorFail: '未検出',
};

export function pickLang(explicit) {
  if (explicit === 'en' || explicit === 'ja') return explicit;
  const env = process.env.CCKEEP_LANG || process.env.LC_ALL || process.env.LANG || '';
  return /^ja/i.test(env) ? 'ja' : 'en';
}

export function strings(lang) {
  return lang === 'ja' ? ja : en;
}
