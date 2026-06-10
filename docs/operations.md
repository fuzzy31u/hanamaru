# Hanamaru Operations Runbook

## Initial Setup (one-time)

1. **GCP project**
   ```bash
   # Project ID は世界中で一意なので、本セットアップでは hanamaru-prod-8779 で確保済み。
   # 別環境を作るときは別 suffix (例: hanamaru-prod-NNNN) を使う。
   gcloud config configurations create hanamaru --no-activate    # 任意。会社プロファイルと分離
   gcloud config configurations activate hanamaru
   gcloud config set account fuzzy31u@gmail.com                  # 個人 Gmail に切替
   gcloud projects create hanamaru-prod-8779 --set-as-default    # 既に存在する場合はスキップ
   gcloud billing projects link hanamaru-prod-8779 --billing-account=01EC5C-58EDA3-114FEC
   ```

2. **Terraform apply**
   ```bash
   cd infra/terraform
   terraform init
   terraform apply -var="project_id=hanamaru-prod-8779" -var="image=asia-northeast1-docker.pkg.dev/hanamaru-prod-8779/hanamaru/hanamaru:initial"
   ```
   (`image` を一度仮置きする。後でデプロイ後に置き換える)

3. **Slack App**
   - Slack 管理画面で新規 App 作成 → "From an app manifest"
   - `infra/slack-manifest.yaml` を貼り付け（`request_url` は Cloud Run URL に置換）
   - Install to workspace → Bot Token を取得

4. **Secret Manager に登録**
   ```bash
   echo -n "<slack signing secret>" | gcloud secrets versions add slack-signing-secret --data-file=-
   echo -n "<slack bot token>"     | gcloud secrets versions add slack-bot-token --data-file=-
   echo -n "<oauth client id>"     | gcloud secrets versions add google-oauth-client-id --data-file=-
   echo -n "<oauth client secret>" | gcloud secrets versions add google-oauth-client-secret --data-file=-
   ```

5. **Google OAuth クライアント**
   - GCP Console → APIs & Services → Credentials → Create OAuth 2.0 Client
   - Authorized redirect URI: `http://localhost:4000/oauth/callback`
   - Client ID / Secret を上記 Secret Manager にも反映

6. **Refresh token を取得**
   ```bash
   GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... pnpm auth:google
   # Browser opens, authorize, refresh token is printed
   echo -n "<refresh token>" | gcloud secrets versions add google-calendar-refresh-token --data-file=-
   ```

7. **Attribution hints の初期投入**
   ```bash
   GCP_PROJECT_ID=hanamaru-prod-8779 \
     CHILD1_CALENDAR_ID=... CHILD1_SCHOOL=... CHILD1_JUKU=... \
     CHILD2_CALENDAR_ID=... CHILD2_SCHOOL=... CHILD2_JUKU=... \
     CHILD3_CALENDAR_ID=... CHILD3_DAYCARE=... \
     SELF_CALENDAR_ID=... \
     pnpm seed:config
   ```

8. **初回デプロイ**
   - GitHub Actions の `Deploy` workflow を `workflow_dispatch` で起動
   - 完了後、`scripts/deploy.sh sha-<commit>` で 100% トラフィック切替

9. **Slack Event URL を Cloud Run URL に設定**
   - Slack App 設定 → Event Subscriptions → Request URL を更新
   - Verify が通れば OK

10. **`#hanamaru` に bot を invite**
    ```
    /invite @Hanamaru
    ```

11. **`ALLOWED_USER_IDS` を Cloud Run に設定**
    ```bash
    gcloud run services update hanamaru \
      --region=asia-northeast1 \
      --update-env-vars=ALLOWED_USER_IDS=U_YOUR_ID
    ```

## Daily ops

### View logs

```bash
gcloud logging read 'resource.type=cloud_run_revision AND resource.labels.service_name=hanamaru' --limit=50 --format=json
```

### Rollback

```bash
gcloud run services update-traffic hanamaru --region=asia-northeast1 --to-revisions=PREVIOUS_REVISION=100
```

### Rotate Slack secrets

1. Slack Admin で signing secret / bot token を再発行
2. `gcloud secrets versions add ... --data-file=-` で新バージョンを追加
3. Cloud Run リビジョンを再デプロイ（または Secret reference を新バージョンに）

### Rotate Google refresh token

`pnpm auth:google` をローカルで再実行 → 新トークンを Secret Manager に追加。

### MongoDB MCP feature (有効化手順)

MongoDB MCP は feature flag (`ENABLE_MONGO_MCP`) で制御される。デフォルトは無効で、無効のままなら接続文字列が未投入でもサービスは起動できる。

関連する env / secret:

- `ENABLE_MONGO_MCP` — plain env var。`true` で有効化（Terraform 変数 `enable_mongo_mcp`、デフォルト `false`）。
- `MONGO_DB_NAME` — plain env var。未設定なら `hanamaru`（Terraform 変数 `mongo_db_name`、デフォルト `hanamaru`）。
- `MDB_MCP_CONNECTION_STRING` — Atlas 接続文字列。本番では Secret Manager の `mdb-mcp-connection-string`（secret container は Terraform 管理、値は out-of-band 投入）。

1. **接続文字列を Secret Manager に投入**（他の secret と同じ手順。secret container は `terraform apply` 済みであること）

   ```bash
   echo -n "mongodb+srv://<user>:<pass>@<cluster>/?retryWrites=true&w=majority" \
     | gcloud secrets versions add mdb-mcp-connection-string --data-file=-
   ```

2. **Cloud Run に secret env と feature flag を設定**

   ```bash
   gcloud run services update hanamaru \
     --region=asia-northeast1 \
     --update-secrets=MDB_MCP_CONNECTION_STRING=mdb-mcp-connection-string:latest \
     --update-env-vars=ENABLE_MONGO_MCP=true,MONGO_DB_NAME=hanamaru
   ```

   無効化するときは `--update-env-vars=ENABLE_MONGO_MCP=false`。

> Note: Cloud Run の env / secret env は Terraform の `lifecycle.ignore_changes`（`template[0].containers[0].env`）対象であり、実値は上記 gcloud / デプロイワークフローで管理する。Terraform は secret container と IAM（runtime SA への `roles/secretmanager.secretAccessor`、project レベル）のみ管理する。`mongodb-mcp-server` は production 依存に含まれるため、コンテナ内で subprocess として起動できる（ランタイムでの network fetch は不要）。

## E2E manual checklist (before release)

```text
☐ 単純テキスト投稿（高信頼）→ Calendar 登録
☐ 学校だより画像 → 複数イベント抽出
☐ 曖昧投稿 → 確認質問 → ✅ で登録
☐ #長女 prefix → 長女のカレンダー
☐ ❌ → 登録済み削除
☐ Slack retry シミュレート → 重複登録なし
```

## Common issues

- **Slack signature verification fails locally:** Make sure ngrok is forwarding to port 8080 and the Slack App request URL is the ngrok URL.
- **Firestore emulator not found in tests:** Run `pnpm emulator:firestore` before `pnpm test:integration`.
- **Vertex AI 403:** SA `hanamaru-runtime@` lacks `roles/aiplatform.user`. Re-apply Terraform.
- **OAuth refresh token revoked:** Re-run `pnpm auth:google` and update the secret.
- **Local Node version:** Project requires Node 22+. Use `nvm use 22` before running anything.
- **Java not installed for emulator:** `brew install openjdk` and add `/opt/homebrew/opt/openjdk/bin` to PATH.
