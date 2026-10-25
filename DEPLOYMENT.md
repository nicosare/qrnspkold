# Roadnote server deployment

## Required configuration

1. Copy `.env.example` to `.env`.
2. Set `VK_APP_SECRET` to the protected key from VK Mini Apps settings. Never commit `.env`.
3. Keep `ADMIN_VK_ID=125479262` unless the administrator account changes.

## Deploy on the existing server

Run from `/home/roadnote-deploy/roadnote-source`:

```bash
cp -n .env.example .env
nano .env
mkdir -p data
chmod 700 data
docker compose up -d --build
```

The compose configuration keeps SQLite in `./data/roadnote.sqlite` on the host, outside the container lifecycle, and binds the app only to `127.0.0.1:3003` for the existing nginx proxy.

If the current container was created manually rather than by Compose, inspect it before the first `docker compose up`. Compose may report that the container name is already in use; in that case stop/remove only the old `roadnote-app` container after confirming its data is not needed from the container writable layer. Do not remove the existing `/home/roadnote-deploy/roadnote-source/data` directory after setup.

## Verify

```docker
docker compose ps
curl -fsS http://127.0.0.1:3003/health
curl -I https://tintink.ru/roadnote/
```

Open `https://tintink.ru/roadnote/admin/users` from inside the VK Mini App so VK launch parameters are present. A normal browser visit is not authenticated.
