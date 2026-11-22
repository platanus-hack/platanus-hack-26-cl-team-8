# Handoff: publicar la arena en https://prompt-arena.si

Para el agente que trabaja en la máquina con la cuenta de Cloudflare del dominio y con SSH al servidor casero. La guía completa es [docs/CLOUDFLARE.md](../CLOUDFLARE.md); esto es el estado de hoy y la lista para cerrar.

## Meta

- `https://prompt-arena.si` muestra la pelea en vivo; `/arena` el leaderboard; `/bench` los benchmarks.
- El sitio sale por un Cloudflare Tunnel desde el servidor casero. No se abren puertos.
- Mirar es público. Cambiar algo pide clave (equipo o invitado).

## Estado al 2026-11-22 04:30 UTC (visto desde afuera)

- Hecho: el dominio usa los nameservers de Cloudflare (`elsa` y `keaton`).
- Hecho: el túnel está creado en la cuenta de Cloudflare.
- Falta: `https://prompt-arena.si` todavía muestra la página "Parked Domain" de Hostinger. Cloudflare importó los registros del estacionamiento y siguen ahí.
- Sin confirmar: que `TUNNEL_TOKEN` esté en el `.env` del servidor y que `cloudflared` esté corriendo.
- El servidor corre `main` (`0a1fc76`): tiene el túnel, pero no el control de acceso. El control de acceso está en `dev` (`d5b3364`) y llega con un PR a `main` que decide el usuario.

## Reglas

- No pegues secretos en el chat ni en el repo: `TUNNEL_TOKEN`, `ADMIN_PASSPHRASE`, `PLAYER_PASSPHRASE`, contraseñas.
- No inicies ni detengas peleas en el servidor sin preguntar al usuario: puede haber benchmarks corriendo. Las pruebas de abajo solo leen.
- No corras `docker compose down`: baja también el túnel.
- No pongas Cloudflare Access delante del sitio completo: la arena es pública a propósito.
- No abras un PR a `main` ni cambies ramas de despliegue sin que el usuario lo pida.

## SSH al servidor casero

```bash
ssh <usuario>@100.82.5.31      # IP de Tailscale: esta máquina debe estar en la tailnet
cd ~/phack2026                 # carpeta del despliegue (DEPLOY_PATH)
```

- Usuario y contraseña: los tiene el usuario (en su `.env` local, claves `home_server_uname` y `home_server_pwd`). Pídeselos; no los escribas en archivos del repo.
- Docker pide `sudo` en el servidor.
- El `.env` del servidor se edita a mano ahí mismo. Los despliegues no lo pisan.

## Lista

### 1. DNS en Cloudflare

- [ ] En **DNS → Records** del dominio, borra los registros importados del estacionamiento: `A`/`AAAA`/`CNAME` de la raíz (`prompt-arena.si`) y de `www`. Deja los que no sean de web (por ejemplo `MX` o `TXT`, si el usuario los quiere).

### 2. Token en el servidor

- [ ] En el túnel (**Networking → Tunnels → el túnel → Configure**), copia el token del comando de instalación para Docker: el texto que empieza con `eyJ`. No ejecutes ese comando.
- [ ] En el servidor, agrega `TUNNEL_TOKEN=eyJ...` al `.env`. No cambies `WEB_BIND` todavía.

### 3. Ruta del sitio

- [ ] En el túnel: **Routes → Add route → Published application**. Subdomain vacío, Domain `prompt-arena.si`, Service tipo **HTTP**, URL `web:80`.
- [ ] Opcional: `www.prompt-arena.si` con una regla de redirección a la raíz.

### 4. Levantar el túnel

- [ ] Desde la máquina que despliega: `DEPLOY_TUNNEL=1` en `.env.deploy` y `bash scripts/deploy-main.sh --force`. Si no hay máquina de despliegue a mano, en el servidor: `sudo docker compose --profile tunnel up -d cloudflared`.
- [ ] En el servidor: `sudo docker compose --profile tunnel ps cloudflared` dice `healthy`, y los logs muestran "Registered tunnel connection".
- [ ] En el panel, el túnel aparece **Healthy**.

### 5. Verificar desde afuera

Un 200 no basta: la página de Hostinger responde 200 a cualquier ruta. Mira el contenido.

```bash
curl -sS https://prompt-arena.si/healthz                 # exactamente: ok
curl -sS https://prompt-arena.si/api/health              # JSON del orquestador
curl -sSI https://prompt-arena.si/live/arena/index.m3u8  # 200, Cache-Control: no-store, cf-cache-status DYNAMIC o BYPASS
curl -sS -o /dev/null -w '%{http_code}\n' --http1.1 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  --max-time 5 https://prompt-arena.si/api/ws            # 101
```

- [ ] Las cuatro pruebas dan lo esperado.
- [ ] En el navegador: `https://prompt-arena.si` carga con candado, el video corre y el marcador se actualiza. `/arena` muestra la liga.
- [ ] Opcional, en el servidor: `BASE_URL=https://prompt-arena.si SMOKE_SKIP_MATCH=1 bash scripts/smoke.sh` (no inicia peleas).

### 6. Cerrar la entrada directa

- [ ] Con el paso 5 en verde: `WEB_BIND=127.0.0.1` en el `.env` del servidor y `sudo docker compose --profile tunnel up -d web`.
- [ ] `http://100.82.5.31:8080` ya no responde desde otra máquina. Dentro del servidor sigue en `http://127.0.0.1:8080`.

### 7. Antes de compartir el QR

- [ ] Tope de gasto en la clave del Vercel AI Gateway.
- [ ] Regla de rate limiting en Cloudflare (**Security → WAF → Rate limiting rules**), 20 pedidos cada 10 s por IP, acción Block:
  `(http.host eq "prompt-arena.si" and http.request.method in {"POST" "PUT" "DELETE"} and starts_with(http.request.uri.path, "/api/"))`
- [ ] Control de acceso (solo cuando `d5b3364` esté en `main` y desplegado): `ADMIN_PASSPHRASE=...` y, para el jurado, `PLAYER_PASSPHRASE=...` en el `.env` del servidor; luego recrea el orquestador con el despliegue. Mientras `/api/access` responda 404, el servidor no tiene el control y cualquiera puede cambiar la arena.
- [ ] Comprobación del acceso: `curl -sS https://prompt-arena.si/api/access` responde `{"enabled":true,"role":"visitor"}`; un `PUT /api/settings` sin clave responde 403; con la cabecera `x-arena-key: <clave de equipo>` responde 200.

## Si algo falla

- **Sigue la página de Hostinger:** quedan registros importados en la raíz, o la ruta no se creó.
- **502:** el servicio de la ruta no es `http://web:80`, o `web` está abajo.
- **Error 1033 o túnel Down:** token mal copiado o `cloudflared` sin levantar con el perfil `tunnel`.
- **Timeouts de `cloudflared`:** `TUNNEL_TRANSPORT_PROTOCOL=http2` en el `.env` del servidor.
- **Video congelado:** una Cache Rule del dominio cubre `/live/*`; no debe.

Más casos en "Problemas comunes" de [docs/CLOUDFLARE.md](../CLOUDFLARE.md).

## Qué reportar al terminar

Qué casillas quedaron hechas, la salida de las pruebas del paso 5, y lo que no se pudo hacer con su error exacto.
