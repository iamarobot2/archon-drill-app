# drill-app

A tiny Node HTTP service (no dependencies) with fault switches, for rehearsing monitoring, auto-restart and rollback. Not a product.

Routes: `GET /health`, `GET /` and `/work` (the traffic), `GET|POST|DELETE /fault` (admin, header `x-drill-token`).

Admin token: set `ADMIN_TOKEN` (or `ADMIN_TOKEN_SHA256`, hex). Without one the fault API refuses everyone. `DATA_DIR` (default the temp dir) holds the crash marker.

Faults, switched on with `POST /fault` and a JSON body, all expiring (`ttlMs`, at most 30 min):
- `{"kind":"health-fail"}` health answers 500
- `{"kind":"error-rate","fraction":0.5}` that share of requests answer 500
- `{"kind":"latency","delayMs":3000}`
- `{"kind":"leak","mbPerSec":16,"limitMb":4096}` memory grows until the container limit kills it
- `{"kind":"crash-loop"}` writes a marker in `DATA_DIR` and exits; every start exits while the marker lives. Put `DATA_DIR` on an emptyDir/volume that survives a container restart but not a replaced pod, so replacing the pod cures it
- `{"kind":"crash-on-start"}` the same, for one boot only
- Bad release: build an image with `--build-arg APP_VERSION=2 --build-arg BROKEN=true`; its `/health` answers 500.

`DELETE /fault` clears everything. `npm test` runs the tests.

Build: `docker build -t drill-app:v1 .` and `docker build -t drill-app:v2 --build-arg APP_VERSION=2 --build-arg BROKEN=true .`
