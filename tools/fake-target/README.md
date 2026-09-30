# fake-target (dev-only outage simulator)

Started by `docker compose up -d`, or locally with `pnpm --filter @app/fake-target dev:local` (stop the compose service first; both use port 4100).

| Port | What                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------- |
| 4100 | HTTP routes below, plus WebSocket echo at `/ws`                                                          |
| 4101 | Same routes over HTTPS with a self-signed certificate that expires in `FAKE_TARGET_TLS_DAYS` (default 5) |
| 4102 | TCP echo                                                                                                 |

| Route                                                  | Behavior                                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `/ok`                                                  | 200                                                                                      |
| `/fail?status=`                                        | 500 (or the given 4xx/5xx)                                                               |
| `/status?code=`                                        | Any status code                                                                          |
| `/slow?ms=`                                            | Waits, then 200 (max 60 s)                                                               |
| `/flap?period=`                                        | Alternates 200/503 every `period` seconds                                                |
| `/keyword?word=`                                       | HTML body containing `word`                                                              |
| `/json`, `/invalid-json`                               | Valid JSON document / broken JSON                                                        |
| `/big`                                                 | 2 MB body (over the 1 MB read limit)                                                     |
| `/gzip-bomb`                                           | Small gzip body that inflates to 10 MB                                                   |
| `/redirect?to=`, `/redirect-loop`, `/redirect-private` | Redirect cases (the last points at 169.254.169.254)                                      |
| `/switch`                                              | 200 or 500 depending on the switch; `POST /control/switch?state=ok\|fail\|slow` flips it |
| `/healthz`                                             | Container healthcheck                                                                    |
