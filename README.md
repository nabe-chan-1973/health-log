# 血圧・体重トラッカー

朝の血圧（最高・最低）・脈拍と、夜の体重を記録するオフライン対応の PWA です。
データは端末内（IndexedDB）にのみ保存され、サーバーには送信されません。

## 機能

- **入力**: 日付・血圧（最高/最低）・脈拍・体重・メモを記録（1日1レコード）
- **血圧計から取り込み**: Web Bluetooth API で標準血圧サービス（`0x1810` / 測定値 `0x2A35`）から自動入力。
  IEEE-11073 SFLOAT のパース実装込み。非対応・未接続時は手入力にフォールバック
- **グラフ**: Chart.js で推移を折れ線表示。**135/85 の目安ライン**を点線で重ねる。期間切替（1週 / 1ヶ月 / 3ヶ月）
- **一覧**: 表形式で表示し、**CSV エクスポート**（Excel 文字化け対策の BOM 付き）
- **PWA**: `manifest.json` + Service Worker でホーム画面追加・オフライン動作に対応

## ファイル構成

```
index.html                  画面（入力 / グラフ / 一覧タブ）
app.js                      ロジック（IndexedDB / Bluetooth / グラフ / CSV）
style.css                   スタイル（落ち着いた色味）
manifest.json               PWA マニフェスト
sw.js                       Service Worker（アプリシェルをキャッシュ）
vendor/chart.umd.min.js     Chart.js（オフライン用にローカル同梱）
icons/icon-192.png          アイコン（仮）
icons/icon-512.png          アイコン（仮）
```

## ローカルで試す

Service Worker と Web Bluetooth は `file://` では動かないため、簡易サーバー経由で開きます。

```bash
# このフォルダで
python -m http.server 8000
# → ブラウザで http://localhost:8000 を開く
```

> Web Bluetooth は Android Chrome / デスクトップ Chrome などで利用できます（iOS Safari は非対応）。
> 非対応環境でも手入力で問題なく使えます。

## GitHub Pages で公開する手順

1. GitHub で新しいリポジトリを作成（例: `health-log`）。

2. このフォルダを push する。

   ```bash
   git init
   git add .
   git commit -m "血圧・体重トラッカー 初版"
   git branch -M main
   git remote add origin https://github.com/<ユーザー名>/health-log.git
   git push -u origin main
   ```

3. GitHub のリポジトリページで **Settings → Pages** を開く。

4. **Build and deployment** の **Source** を **Deploy from a branch** にし、
   Branch を **`main` / `(root)`** に設定して **Save**。

5. 数十秒〜数分後、`https://<ユーザー名>.github.io/health-log/` で公開されます。

> パスはすべて相対指定にしてあるため、リポジトリ名のサブパス配下でもそのまま動作します。

## Pixel（Android）のホーム画面に追加する手順

1. **Chrome** で公開 URL（`https://<ユーザー名>.github.io/health-log/`）を開く。
2. 右上の **⋮（メニュー）** をタップ。
3. **「ホーム画面に追加」** または **「アプリをインストール」** をタップ。
4. 名前を確認して **「追加」/「インストール」**。
5. ホーム画面のアイコンから起動すると、アドレスバーのない全画面アプリとして動きます。
   一度オンラインで開けば、以降は **オフラインでも利用可能**です。

> ホーム画面追加の項目が出ないときは、一度ページを再読み込みし、
> オンライン状態で Service Worker が登録されるのを待ってから試してください。

## 血圧計との接続について

- 対応するのは **Bluetooth GATT の標準「Blood Pressure」サービス（`0x1810`）** を実装した機器です。
- 「血圧計から取り込む」をタップ → デバイスを選択 → 機器側で測定すると、
  測定値が `0x2A35` の通知（Indicate）で届き、入力欄へ自動反映されます。
- 単位が kPa の機器は mmHg に自動換算します。
- 機器が見つからない・対応していない場合は、そのまま手入力してください。

## メモ

- アイコンは仮（ハートのプレースホルダー）です。差し替える場合は `icons/icon-192.png` と
  `icons/icon-512.png` を同名で置き換えてください。
- データはブラウザのストレージ（IndexedDB）に保存されます。ブラウザのデータ消去や
  アプリ削除で消えるため、必要に応じて CSV エクスポートでバックアップしてください。
