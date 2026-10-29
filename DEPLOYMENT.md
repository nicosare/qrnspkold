# QRide server deployment

## Required configuration

1. Copy `.env.example` to `.env`.
2. Set `VK_APP_SECRET` to the protected key from VK Mini Apps settings. Never commit `.env`.
3. Keep `ADMIN_VK_ID=125479262` unless the administrator account changes.

## Deploy on the existing server

Run from `/home/qride-deploy/qride-source`:

```bash
cp -n .env.example .env
nano .env
mkdir -p data
chmod 700 data
docker compose up -d --build
```

The compose configuration keeps SQLite in `./data/qride.sqlite` on the host, outside the container lifecycle, and binds the app only to `127.0.0.1:3003` for the existing nginx proxy.

If the current container was created manually rather than by Compose, inspect it before the first `docker compose up`. Compose may report that the container name is already in use; in that case stop/remove only the old `qride-app` container after confirming its data is not needed from the container writable layer. Do not remove the existing `/home/qride-deploy/qride-source/data` directory after setup.

## Verify

```docker
docker compose ps
curl -fsS http://127.0.0.1:3003/health
curl -I https://tintink.ru/qride/
```

Open `https://tintink.ru/qride/admin/users` from inside the VK Mini App so VK launch parameters are present. A normal browser visit is not authenticated.


## Tariff applications and community bot

Tariff requests are stored in the existing SQLite database at \`data/qride.sqlite\`; do not delete the \`data\` directory. The app fixes the price on each request. The promotional price is available until the first request that you approve; after an approved purchase, the UI shows ordinary prices for all offers. Rejected or replaced requests do not consume the first-purchase discount.

Add these values to the existing server \`.env\` (do not commit or share the real token):

- \`VK_GROUP_ID=242494208\`
- \`VK_GROUP_TOKEN\` — a community access token with permission to use messages.
- \`VK_CALLBACK_SECRET\` — a random secret that exactly matches the secret key configured for the Callback API server.
- \`VK_CALLBACK_CONFIRMATION\` — the confirmation code shown by VK for that Callback API server.

Then in the VK community settings, open **Management → API → Callback API**, create a server with URL \`https://tintink.ru/qride/api/vk/callback\`, enter the same secret key, save the confirmation code in \`.env\`, and enable the **incoming messages** and **message event** event types. Confirm the server in VK. Make sure the administrator account can receive messages from the QRide community as well.

Rebuild only the QRide app after editing \`.env\`:

\`\`\`bash
cd /home/qride-deploy/qride-source
docker compose up -d --build qride-app
curl -fsS --max-time 10 http://127.0.0.1:3003/health
\`\`\`

A customer must allow messages from the community when pressing **Оставить заявку**. The community sends the tariff details and the current price, then waits for a photo screenshot. The administrator receives the screenshot with **Начислить** and **Отменить** callback buttons. Decisions are idempotent: a closed or replaced request cannot be credited again. The payment link is intentionally a placeholder until the real URL is supplied.
