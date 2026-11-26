export const stationActions = Object.freeze({
  diagnose: "端末診断",
  sync: "通信・データ同期の再試行",
  stop: "計測を停止",
  camera: "カメラを再取得",
  engine: "認識エンジンを再初期化",
  recalibrate: "現地に再調整を依頼",
});
export const stationResults = Object.freeze({
  ok: "完了",
  busy: "通過追跡・検証中のため未実行",
  local: "現地操作が必要",
  interrupted: "画面の再読み込み等で結果を確認できません",
  stale: "端末設定が変更されたため未実行",
  failed: "失敗",
});

export function sameStationScope(command, station, mode, version) {
  return command.device === station.device && command.role === station.role && command.mode === mode &&
    command.configVersion === version && command.assignment?.isEqual(station.updatedAt) === true;
}

export function pairingCode(random = crypto) {
  const bytes = new Uint32Array(1);
  do { random.getRandomValues(bytes); } while (bytes[0] >= 4294000000);
  return String(bytes[0] % 1000000).padStart(6, "0");
}
