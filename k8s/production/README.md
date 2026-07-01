# Kubernetes Production Manifests

These manifests deploy the Node signaling server and RTMP/media server behind Kubernetes Services and an Ingress. The static client can stay on Hostinger; point the client build env at the Ingress hosts when migrating the runtime services.

## Build Images

Build and push images from the existing Dockerfile targets:

```sh
export IMAGE_TAG=$(git rev-parse --short HEAD)
export REGISTRY=registry.example.com

docker build --target server -t "$REGISTRY/livestream-studio-server:$IMAGE_TAG" .
docker build --target media-server -t "$REGISTRY/livestream-studio-media-server:$IMAGE_TAG" .

docker push "$REGISTRY/livestream-studio-server:$IMAGE_TAG"
docker push "$REGISTRY/livestream-studio-media-server:$IMAGE_TAG"
```

Then update `kustomization.yaml` image `newName` and `newTag` values.

## Configure Secrets

Create the namespace and secret before applying the kustomization:

```sh
kubectl apply -f namespace.yaml
cp secret.template.yaml /tmp/livestream-studio-secrets.yaml
```

Edit `/tmp/livestream-studio-secrets.yaml` with real values, then apply it:

```sh
kubectl apply -f /tmp/livestream-studio-secrets.yaml
```

`LIVE_STREAM_TOKEN_SECRET` must be the same value for both services. Configure TURN credentials in the same secret so `/health` can report `ice.turnReady: true`.

## Configure Hosts

Before applying, update:

- `configmap.yaml`: `CLIENT_URLS`
- `ingress.yaml`: API and media host names, TLS secret name, and issuer annotation
- Hostinger client build env:
  - `VITE_API_URL=https://<api-host>`
  - `VITE_WS_URL=wss://<api-host>/ws`
  - `VITE_MEDIA_WS_URL=wss://<media-host>/rtmp`
  - `VITE_MEDIA_HTTP_URL=https://<media-host>`

## Apply

```sh
kubectl apply -k .
kubectl -n livestream-studio rollout status deploy/livestream-studio-server
kubectl -n livestream-studio rollout status deploy/livestream-studio-media-server
```

## Smoke Check

```sh
curl -fsS https://<api-host>/health
curl -fsS https://<media-host>/health
```

Run the repository smoke check against the Kubernetes hosts:

```sh
PRODUCTION_API_URL=https://<api-host> \
PRODUCTION_MEDIA_HTTP_URL=https://<media-host> \
PRODUCTION_REQUIRE_TURN=true \
npm run production:check
```

## Scaling Notes

The current signaling room state, media relay sessions, upload sessions, and export jobs are in memory. These manifests intentionally start each service at one replica. Increase replicas only after adding shared state for rooms, uploads, exports, and WebRTC/SFU routing.
