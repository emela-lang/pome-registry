# pome-registry

Emela の Pome（4.7）の proxy と checksum DB．ID と版の真実は git にあり，ここは写しと証人だけを持つ．

| パッケージ | 中身 |
|---|---|
| `packages/protocol` | source path，version，`h1:` ハッシュ，URL と R2 の並び，sumdb の記録，ingester の API と署名，Merkle tree と tile，署名付きの note，アーカイブ（tar.gz） |
| `packages/sumdb` | `sum.emela.ab2m.link`．読みは R2 から返し，追記は Durable Object の `Log` が SQLite で持つ |
| `packages/proxy` | `pomes.emela.ab2m.link`．R2 から配り，ない版は ingester に取り込ませる．`@v/list` は git の smart HTTP で直接引く |
| `packages/ingester` | 手元のサーバーで動く Node のサービス（Docker）．git で tag を浅く取り，検査して tar.gz とハッシュを返す |

木と署名は C2SP の tlog-tiles，tlog-checkpoint，signed-note に従う．`testdata/tlog-vectors.json` は別の実装で作った値で，Rust のクライアントも同じものを通す．

```sh
pnpm install
pnpm check
pnpm test
```

## 書き込みの経路

ingester は資格情報を持たない．git から取って検査し，ハッシュとアーカイブを返すだけで，R2 と sumdb（DO の Log）に書くのは proxy の Worker．

proxy はアーカイブを展開して `h1:` を計算し直し，ingester の答えと照らしてから sumdb に記録する．自宅のサーバーが乗っ取られても，R2 と sumdb の鍵は漏れず，配る中身と sumdb の記録が食い違うこともない（git と違う中身を記録させることはできるが，`direct` で取った利用者の照合で見つかる）．

sumdb の lookup にない版は，sumdb の Worker が proxy に `.info` を求めて取り込ませてから返す（`direct` で取った利用者のため）．proxy は Custom Domain なので service binding なしに fetch で呼ぶ．proxy は sumdb の Durable Object を束縛しているので，逆向きにも束縛すると deploy の順が決まらない．

取り込みの順は「sumdb に記録 → R2 にアーカイブと `.toml` → `.info`」．`.info` があれば全部そろっている．同じ版に別の中身の記録があれば（tag の付け替え）410 で断る．

## deploy

sumdb を先に置く．proxy は sumdb の Durable Object を `script_name` で引く．

```sh
cd packages/sumdb
pnpm genkey sum.emela.ab2m.link          # signer は秘密，verifier はコンパイラに埋め込む
npx wrangler r2 bucket create pome-sumdb
npx wrangler secret put SUMDB_SIGNER_KEY # signer を貼る
pnpm deploy
```

鍵を替えると，古い公開鍵を埋め込んだコンパイラがすべて検証に落ちる．秘密鍵は失くさないこと．

ingester を手元のサーバーで起こす．ポートは外に開けず，cloudflared が Tunnel を張る．

```sh
cd packages/ingester
export INGEST_SECRET=$(openssl rand -hex 32)   # proxy と同じ値．32 文字以上
export TUNNEL_TOKEN=...                        # ダッシュボードで作った Tunnel のトークン
docker compose up -d --build
```

Tunnel に Workers VPC Service を作り，宛先を `http://ingester:8080` にする．その service_id を `packages/proxy/wrangler.jsonc` に書く．

```sh
cd packages/proxy
npx wrangler r2 bucket create pome-proxy
npx wrangler secret put INGEST_SECRET    # ingester と同じ値
pnpm deploy
```

コンテナは読み取り専用で，書けるのは `/tmp`（512 MiB）だけ．git は手元の設定と資格情報を読まず，https 以外のプロトコルを使わない．

## 未決

- v2 以上の major の ID（仕様 18.1 #40）．path に `/v2` を付けるかを決めていない
- アーカイブは `.tar.gz`．ハッシュは木から取るので，後で形式を替えても lock は壊れない
- ingester の応答（multipart）は全部をメモリに載せる．大きさの上限（32 MiB）で抑えている
- ingester は tag の commit をまるごと取ってから大きさを検査する．取得は 30 秒で打ち切り，`/tmp` は 512 MiB に絞っているが，大きなリポジトリの帯域は使われる
- DNS の検査（私的なアドレスを拒む）と git の名前解決は別なので，その間に DNS が変わる余地は残る．host を github.com，codeberg.org，gitlab.com に絞っているので足りる
- 同じ版への同時の要求は，それぞれが ingester を呼ぶ（記録は1つにまとまる）
- `testdata/hash-vectors.json` は Rust のクライアントでも同じものを通す
