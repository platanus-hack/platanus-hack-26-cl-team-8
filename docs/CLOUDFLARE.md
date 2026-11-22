# Publicar el servidor con Cloudflare (sin Tailscale)

Esta guía deja el stack del servidor casero en internet, en tu propio dominio, con un **Cloudflare Tunnel**. Los despliegues por SSH también pasan por Cloudflare, así que al final se puede desinstalar Tailscale.

```
                        Internet
                           |
                    Cloudflare (TLS)
            +--------------+---------------+
            |                              |
   arena.<dominio> (público)      ssh.<dominio> (Cloudflare Access)
            |                              |
            +------- túnel de salida ------+
                           |
                  cloudflared (perfil "tunnel" de compose)
            +--------------+---------------+
            |                              |
       http://web:80              ssh://host.docker.internal:22
       (Caddy -> sitio, /api, /live)   (sshd del servidor)
```

- El túnel es **de salida**: `cloudflared` se conecta a Cloudflare. No se abren puertos en el router ni hace falta IP fija.
- Cloudflare termina el TLS. Caddy sigue hablando HTTP en el puerto 80, igual que hoy.
- El túnel es **administrado desde el panel** de Cloudflare: las rutas (qué hostname va a qué servicio) se configuran allá. En el servidor solo vive el token.
- Esto es distinto de la web como Worker (`apps/web/wrangler.jsonc`, `pnpm local --tunnel`). Esa otra vía sigue igual y no se toca aquí.

En los ejemplos, `tudominio.cl` es tu dominio y `seba` el usuario SSH del servidor. Cámbialos por los tuyos.

> Los nombres de los menús del panel de Cloudflare cambian seguido. Si algo no calza, busca el equivalente: los túneles están en **Networking → Tunnels** (antes **Zero Trust → Networks → Tunnels**) y las aplicaciones de Access en **Zero Trust → Access controls → Applications** (antes **Zero Trust → Access → Applications**).

## Orden recomendado

No apagues Tailscale hasta comprobar que el SSH por Cloudflare funciona. Si cortas Tailscale antes, puedes quedarte sin acceso remoto al servidor.

**Requiere que este cambio ya esté en `main`**: `scripts/deploy-main.sh` despliega `origin/main` (con `git archive`), no lo que tienes en tu copia local. Si todavía no está mezclado, usa `scripts/deploy.sh` (copia tu copia local con rsync) con las variables en el entorno, por ejemplo `DEPLOY_HOST=100.x.y.z DEPLOY_USER=seba DEPLOY_TUNNEL=1 bash scripts/deploy.sh`.

**Si tu usuario necesita sudo para Docker** (`DEPLOY_SUDO=1`), antepón `sudo` a todos los comandos `docker` y `docker compose` de esta guía que se corren en el servidor.

1. Dominio en Cloudflare.
2. Crear el túnel y publicar el sitio (todavía desplegando por Tailscale).
3. Proteger el SSH con Cloudflare Access y recién después publicar `ssh.<dominio>`.
4. Probar el SSH por Cloudflare desde tu máquina.
5. Cambiar `.env.deploy` para desplegar por Cloudflare.
6. Cerrar el puerto 8080 a la red (`WEB_BIND=127.0.0.1`). No es opcional: ver el paso 6.
7. Apagar y desinstalar Tailscale.

## 1. Agregar el dominio a Cloudflare

Si el dominio ya está en tu cuenta de Cloudflare con estado **Active**, salta al paso 2.

1. En el panel de Cloudflare: **Add a domain** (o **Add site**). Escribe el dominio (`tudominio.cl`) y elige el plan **Free**.
2. Cloudflare importa los registros DNS que encuentre. Revísalos: si el dominio ya tiene correo u otros servicios, sus registros (MX, TXT, etc.) deben quedar ahí.
3. Cloudflare te muestra **dos nameservers** (algo como `ada.ns.cloudflare.com` y `bob.ns.cloudflare.com`).
4. En el registrador del dominio, reemplaza los nameservers actuales por esos dos. Para un `.cl`, en [NIC Chile](https://www.nic.cl): entra con tu cuenta, abre el dominio y modifica los **servidores DNS**. Deja solo los dos de Cloudflare.
5. Espera a que Cloudflare marque el dominio como **Active**. Suele tardar minutos, a veces horas. Cloudflare avisa por correo.

El modo SSL/TLS del dominio (Flexible, Full, etc.) **no importa para el túnel**: ese ajuste es para la conexión de Cloudflare a una IP de origen, y aquí el tráfico llega por el túnel.

## 2. Crear el túnel y publicar el sitio

### 2.1 Crear el túnel

1. **Networking → Tunnels → Create a tunnel**. Si pregunta el tipo de conector, elige **Cloudflared**.
2. Nombre: por ejemplo `phack2026-servidor`. Guarda.
3. Cloudflare muestra un comando de instalación (`cloudflared service install eyJ...` o `docker run ... --token eyJ...`). **No lo ejecutes**: aquí cloudflared corre dentro de Docker Compose. Copia solo el **token**, el texto largo que empieza con `eyJ`.

El token es un secreto: con él cualquiera puede conectar un conector a tu túnel. No lo pongas en el repo ni en el chat.

### 2.2 Token en el servidor

En el servidor (todavía por Tailscale), edita el `.env` del proyecto:

```bash
ssh seba@<ip-de-tailscale>
cd ~/phack2026
nano .env
```

```bash
TUNNEL_TOKEN=eyJ...
```

Por ahora no cambies `WEB_BIND`: el sitio sigue también en `http://<servidor>:8080` hasta verificar el túnel.

### 2.3 Ruta pública del sitio

En el túnel: pestaña **Routes → Add route → Published application** (en paneles antiguos: **Public Hostname → Add a public hostname**).

| Campo | Valor |
|---|---|
| Subdomain | `arena` |
| Domain | `tudominio.cl` |
| Path | vacío |
| Service | tipo **HTTP**, URL **`web:80`** (es decir, `http://web:80`) |

Cloudflare crea solo el registro DNS `arena.tudominio.cl` (un CNAME hacia el túnel). Si ya existía un registro con ese nombre, bórralo antes o Cloudflare rechaza la ruta.

`web` es el nombre del servicio en `docker-compose.yml`: cloudflared corre en la misma red de compose y lo resuelve directo. No uses `localhost:8080`: dentro del contenedor de cloudflared, `localhost` es el propio contenedor.

No pongas Cloudflare Access delante del sitio completo: la arena es pública a propósito.

> **Ojo: desde ahora la arena queda abierta a todo internet, no solo al equipo.** El orquestador no tiene cuentas: cualquiera que abra `arena.tudominio.cl` puede cambiar prompts y ajustes, iniciar y detener peleas, lanzar baterías de presets (`POST /api/presets/:id`, muchas peleas seguidas), pedir el juicio de una pelea (`POST /api/matches/:id/judge`, una llamada al LLM por pedido), marcar banderas y vaciar el historial visible (`DELETE /api/history`, que solo pide `{ "confirm": "BORRAR" }`; lo archiva, no lo destruye). Las peleas y el juicio gastan créditos del Vercel AI Gateway. Sin `ADMIN_PASSPHRASE`, la única defensa propia es el límite de 30 pedidos que cambian algo cada 10 s por IP, y quien tenga varias IPs se lo salta.
>
> Antes de publicar:
>
> 0. **Pon `ADMIN_PASSPHRASE` en el `.env` del servidor** (y `PLAYER_PASSPHRASE` si habrá invitados). Con ella, quien visita solo mira, y cambiar algo pide clave: ver "Acceso" en el [README](../README.md#acceso-quién-puede-cambiar-la-arena). Es la defensa principal; lo de abajo la complementa.
> 1. **Pon un tope de gasto** a la clave del Vercel AI Gateway (panel de Vercel → AI Gateway → límites de la clave).
> 2. **Agrega una regla de rate limiting** en Cloudflare (el plan Free trae una): en el dominio, **Security → WAF → Rate limiting rules → Create rule**, con la expresión
>    `(http.host eq "arena.tudominio.cl" and http.request.method in {"POST" "PUT" "DELETE"} and starts_with(http.request.uri.path, "/api/"))`,
>    por ejemplo 20 pedidos cada 10 s por IP, acción **Block**.
> 3. **Opcional**, si las baterías, el juicio y el borrado del historial deben quedar solo para el equipo: crea una aplicación de Access (como la del paso 3.1) con los hostnames `arena.tudominio.cl/api/presets*`, `arena.tudominio.cl/api/history` y `arena.tudominio.cl/api/matches/*/judge`. Access no distingue métodos HTTP: también pedirá login para leer esas rutas (por ejemplo `GET /api/presets`, que usa la web pública), así que esa parte de la web dejará de funcionar para quien no inicie sesión.

### 2.4 Levantar el túnel

Desde tu máquina, con el `.env.deploy` de siempre (Tailscale), agrega `DEPLOY_TUNNEL=1`:

```bash
# .env.deploy
DEPLOY_TUNNEL=1
```

```bash
bash scripts/deploy-main.sh --force
```

Con `DEPLOY_TUNNEL=1` los scripts levantan el perfil `tunnel` y, antes, revisan que el `.env` del servidor tenga `TUNNEL_TOKEN`. Sin token, cloudflared no arranca y se reinicia en bucle.

En el servidor, revisa:

```bash
docker compose --profile tunnel ps cloudflared     # debe quedar "healthy"
docker compose logs --tail 30 cloudflared          # "Registered tunnel connection" (varias veces)
```

El healthcheck usa `cloudflared tunnel ready`: queda `healthy` cuando el túnel tiene al menos una conexión con Cloudflare. En el panel, el túnel aparece como **Healthy**.

Abre `https://arena.tudominio.cl`. Las verificaciones completas están en [Verificación](#verificación).

## 3. SSH por Cloudflare

### 3.1 Primero, Cloudflare Access (obligatorio)

**Crea la aplicación de Access ANTES de publicar `ssh.<dominio>`.** Sin Access, cualquiera con `cloudflared` llega al `sshd` del servidor desde internet, y hoy el servidor acepta contraseña. Con Access, Cloudflare corta la conexión antes de llegar al servidor si la persona no inició sesión con un correo autorizado.

1. **Zero Trust → Access controls → Applications → Create new application** (o **Add an application**) → **Self-hosted** (puede llamarse **Self-hosted and private**).
2. Nombre: `SSH servidor`.
3. **Add public hostname**: subdominio `ssh`, dominio `tudominio.cl`.
4. **Access policies**: crea una política nueva:
   - Nombre: `Equipo`.
   - Action: **Allow**.
   - Include: selector **Emails**, con el correo de cada persona que despliega.
5. **Login methods**: deja **One-time PIN** (Cloudflare manda un código al correo). Si conectaste Google o GitHub como proveedor de identidad, también sirve.
6. **Session Duration**: por ejemplo `24 hours`. Es cada cuánto hay que volver a iniciar sesión.
7. Guarda.

Todas las aplicaciones de Access niegan por defecto: solo entra quien calza con una política **Allow**.

Si es la primera vez que usas Zero Trust, Cloudflare pide elegir un nombre de equipo (team domain) y un plan: el **Free** alcanza (hasta 50 usuarios).

### 3.2 Ruta del SSH en el túnel

En el túnel: **Routes → Add route → Published application**.

| Campo | Valor |
|---|---|
| Subdomain | `ssh` |
| Domain | `tudominio.cl` |
| Service | tipo **SSH**, URL **`host.docker.internal:22`** (es decir, `ssh://host.docker.internal:22`) |

`host.docker.internal` es el propio servidor visto desde el contenedor de cloudflared (`extra_hosts: host-gateway` en `docker-compose.yml`). Así el túnel llega al `sshd` del host, fuera de Docker.

En el servidor, `sshd` tiene que aceptar conexiones desde los contenedores (llegan por la IP del puente de Docker, por ejemplo `172.17.0.1`). Lo normal es que escuche en todas las interfaces. Compruébalo:

```bash
sudo ss -tlnp | grep ':22 '      # debe decir 0.0.0.0:22 o *:22
```

Si dice solo la IP de Tailscale (`100.x.y.z:22`), cambia esa `ListenAddress` en `/etc/ssh/sshd_config` (o en `/etc/ssh/sshd_config.d/`) y reinicia con `sudo systemctl restart sshd`. Tienes dos opciones:

- **Acotada (recomendada):** escuchar solo en el loopback y en la IP del puente de Docker. Mira la IP con `ip -4 addr show docker0` y deja, por ejemplo:
  ```
  ListenAddress 127.0.0.1
  ListenAddress 172.17.0.1
  ```
  `host.docker.internal` (host-gateway) apunta a esa IP de `docker0` desde cualquier red de compose. Esa IP solo existe cuando Docker ya arrancó: para que `sshd` no parta antes tras un reinicio, crea `/etc/systemd/system/sshd.service.d/docker.conf` con `[Unit]` y `After=docker.service`, y corre `sudo systemctl daemon-reload`. Prueba con el `nc` de [Problemas comunes](#problemas-comunes) y reinicia el servidor una vez **antes** de cortar Tailscale.
- **Simple:** quitar la `ListenAddress` para que escuche en todas las interfaces. **Esto abre el SSH con contraseña a toda la red local y a cualquier contenedor del servidor** (incluidos el orquestador y los bots, que corren código guiado por un LLM).

En los dos casos, cuando ya entres con llave, conviene `PasswordAuthentication no` en `sshd_config` y quitar `DEPLOY_PASSWORD` de tu `.env.deploy` (sin contraseña, `DEPLOY_SUDO=1` deja de funcionar: necesitas sudo sin contraseña para docker o agregar tu usuario al grupo `docker`).

### 3.3 Service token para despliegues sin navegador (opcional, recomendado para el loop)

Con la política de correos, `cloudflared` abre el navegador para iniciar sesión cada vez que vence la sesión (por ejemplo cada 24 horas). Para un loop de despliegue sin nadie mirando, crea un **service token**:

1. **Zero Trust → Access controls → Service credentials → Service Tokens → Create Service Token**. Nombre: `deploy`. Duración: por ejemplo un año.
2. Copia el **Client ID** y el **Client Secret**. El secret se muestra **una sola vez**.
3. En la aplicación `SSH servidor`, agrega una segunda política:
   - Action: **Service Auth**.
   - Include: selector **Service Token**, con el token `deploy`. (Si tu panel solo ofrece **Service Token Tag**, etiqueta el token y usa esa etiqueta.)

El service token pasa por Access sin navegador. Guárdalo solo en tu `.env.deploy`.

## 4. Probar el SSH desde tu máquina

### 4.1 Instalar cloudflared

```bash
brew install cloudflared                          # macOS
sudo dnf install cloudflared                      # Fedora, con el repo de Cloudflare
```

Para Fedora, Debian/Ubuntu y Windows, los paquetes y repositorios están en [Downloads](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/). Comprueba con `cloudflared --version`.

### 4.2 Iniciar sesión en Access

```bash
cloudflared access login https://ssh.tudominio.cl
```

Se abre el navegador; entra con tu correo (llega un código). El token queda guardado en `~/.cloudflared/` hasta que vence la sesión.

Con service token no hace falta este paso.

### 4.3 Conectarse

Prueba a mano, **mientras Tailscale sigue arriba**:

```bash
ssh -o ProxyCommand="cloudflared access ssh --hostname %h" seba@ssh.tudominio.cl
```

Para no escribir el `ProxyCommand` cada vez, en `~/.ssh/config`:

```
Host ssh.tudominio.cl
  ProxyCommand cloudflared access ssh --hostname %h
```

Y luego `ssh seba@ssh.tudominio.cl`. Si `cloudflared` no está en el `PATH` de ssh, usa la ruta completa (`which cloudflared`).

La huella del servidor es la misma que por Tailscale, pero ssh la anota de nuevo con el nombre `ssh.tudominio.cl`. `scripts/deploy-main.sh` la acepta sola la primera vez (`StrictHostKeyChecking=accept-new`); `scripts/deploy.sh` y el `ssh` a mano preguntan la huella la primera vez.

Para entrar con un cliente real de Minecraft (puerto 25565 solo en loopback del servidor), el túnel SSH de siempre ahora pasa por Cloudflare:

```bash
ssh -L 25565:127.0.0.1:25565 seba@ssh.tudominio.cl
```

## 5. Desplegar por Cloudflare

Cambia tu `.env.deploy` (en la raíz del repo, ignorado por git):

```bash
DEPLOY_HOST=ssh.tudominio.cl
DEPLOY_USER=seba
DEPLOY_PATH=phack2026
DEPLOY_PASSWORD=...           # igual que antes, si usas contraseña
DEPLOY_SUDO=1                 # igual que antes, si docker necesita sudo
DEPLOY_TUNNEL=1               # siempre: si no, un despliegue no levanta cloudflared
DEPLOY_CF_ACCESS=1            # ssh y rsync pasan por cloudflared access ssh
# Opcional, para correr sin navegador (paso 3.3):
# DEPLOY_CF_TOKEN_ID=xxxxxxxx.access
# DEPLOY_CF_TOKEN_SECRET=...
```

```bash
bash scripts/deploy-main.sh --force
```

`DEPLOY_CF_ACCESS=1` agrega `-o ProxyCommand="cloudflared access ssh --hostname %h"` a cada `ssh` y al `rsync`, y funciona junto con `DEPLOY_PASSWORD` (sshpass) y `DEPLOY_SUDO=1`.

`scripts/deploy.sh` también entiende `DEPLOY_CF_ACCESS`, `DEPLOY_CF_TOKEN_ID` y `DEPLOY_CF_TOKEN_SECRET`, pero **no lee `.env.deploy`** y no maneja contraseña ni sudo: pásale las variables en el entorno, por ejemplo `DEPLOY_HOST=ssh.tudominio.cl DEPLOY_USER=seba DEPLOY_CF_ACCESS=1 DEPLOY_TUNNEL=1 bash scripts/deploy.sh`. Sirve si entras con llave y tu usuario usa docker sin sudo.

Sin service token, los dos scripts revisan antes del primer `ssh` que haya un login de Access vigente (`cloudflared access token`). Si venció, terminan al tiro (código 2) con `Venció o no hay login de Cloudflare Access: corre cloudflared access login https://ssh.tudominio.cl` (en `deploy-main.sh`, precedido de `SERVIDOR NO RESPONDE:`). Corre ese comando y vuelve a intentar.

**Cuidado: el SSH ahora depende de cloudflared, que corre en Docker.**

- Cuando un despliegue recrea el contenedor `cloudflared` (por ejemplo, al cambiar su versión en `docker-compose.yml`), la conexión SSH se corta unos segundos. Los scripts dejan que `docker compose up` termine igual en el servidor; si avisan del corte, espera un minuto y vuelve a correrlos.
- **No corras `docker compose down` por el SSH de Cloudflare.** Baja también cloudflared: se corta tu sesión y el túnel no vuelve hasta que alguien lo levante en el servidor. Para detener la arena sin perder el acceso:
  ```bash
  docker compose stop minecraft orchestrator camera mediamtx web
  ```
- Docker debe arrancar solo al encender el servidor (`sudo systemctl enable docker`). Los contenedores tienen `restart: unless-stopped`, así que cloudflared vuelve solo tras un reinicio.

## 6. Cerrar el puerto 8080 a la red (obligatorio)

Este paso no es opcional cuando el túnel es la única entrada. Con el sitio funcionando por `https://arena.tudominio.cl`, en el `.env` del servidor:

```bash
WEB_BIND=127.0.0.1
```

Y aplica (desde el servidor, o con `bash scripts/deploy-main.sh --force`):

```bash
docker compose --profile tunnel up -d web
```

Ahora el sitio solo sale por el túnel. En el servidor sigue en `http://127.0.0.1:8080`, que es lo que usa `scripts/smoke.sh`.

Esto también importa para el límite por IP del orquestador: toma la IP de la cabecera `cf-connecting-ip`. Por el túnel la pone Cloudflare (y pisa la que mande el cliente), pero con el puerto abierto a la red, cualquiera de la red local puede mandarla inventada, cambiarla en cada pedido y saltarse el límite. Además, los puertos que publica Docker no pasan por firewalld: cerrarlo en el firewall no basta. Mientras no hagas este paso, el puerto 8080 sigue abierto a la red local.

## 7. Apagar Tailscale

Solo cuando ya comprobaste los pasos 4 y 5 (SSH y un despliegue completo por Cloudflare):

```bash
# en el servidor, entrando por ssh.tudominio.cl
sudo tailscale down
```

Deja pasar un día de uso normal. Si todo sigue bien, desinstálalo:

```bash
sudo systemctl disable --now tailscaled
sudo dnf remove tailscale            # Fedora; en Debian/Ubuntu: sudo apt remove tailscale
```

Y en el panel de Tailscale, borra la máquina. Ten a mano un acceso de respaldo (teclado y pantalla, o la red local) por si el túnel se cae.

## Verificación

Desde cualquier máquina con internet:

```bash
curl -sS https://arena.tudominio.cl/healthz                 # ok
curl -sS https://arena.tudominio.cl/api/health              # JSON del orquestador
curl -sSI https://arena.tudominio.cl/live/arena/index.m3u8  # 200 con Cache-Control: no-store
```

El websocket (`/api/ws`) se prueba pidiendo el upgrade a mano:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' --http1.1 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  --max-time 5 https://arena.tudominio.cl/api/ws
# 101 = websocket abierto (curl corta a los 5 s; es normal)
```

En el navegador: abre `https://arena.tudominio.cl`, mira que el video corra y que el marcador se actualice durante una pelea.

En el servidor, la cadena completa: `bash scripts/smoke.sh`. Para que las pruebas HTTP pasen por Cloudflare en vez del loopback:

```bash
BASE_URL=https://arena.tudominio.cl SMOKE_SKIP_MATCH=1 bash scripts/smoke.sh
```

Lista:

- [ ] `https://arena.tudominio.cl` carga el sitio con candado (TLS de Cloudflare).
- [ ] `/healthz` responde `ok` y `/api/health` responde el JSON.
- [ ] El websocket responde `101` y la web muestra el estado en vivo.
- [ ] El video HLS se ve en la web.
- [ ] `ssh seba@ssh.tudominio.cl` pide login de Access (o usa el service token) y entra.
- [ ] Una ventana privada en `https://ssh.tudominio.cl` muestra la pantalla de login de Cloudflare Access, no el servidor.
- [ ] `bash scripts/deploy-main.sh --force` despliega por Cloudflare.
- [ ] **Obligatorio:** `WEB_BIND=127.0.0.1` en el `.env` del servidor, y `http://<ip-del-servidor>:8080` ya no responde desde otra máquina.
- [ ] La clave del Vercel AI Gateway tiene tope de gasto y existe la regla de rate limiting para `/api/` (paso 2.3).

## Problemas comunes

**502 Bad Gateway en `arena.<dominio>`.** cloudflared no llega al servicio de la ruta. Revisa que el servicio sea `http://web:80` (no `https`, no `localhost:8080`) y que `web` esté arriba (`docker compose ps web`). Los logs de `cloudflared` dicen a qué dirección intentó conectar.

**Error 1033 o el túnel aparece Down/Inactive.** cloudflared no está conectado. Mira `docker compose logs cloudflared`: un token mal copiado da error de autenticación. Comprueba que levantaste con el perfil (`--profile tunnel` o `DEPLOY_TUNNEL=1`).

**cloudflared no conecta: timeouts con QUIC.** cloudflared sale a Cloudflare por el puerto **7844**, por UDP (QUIC) o TCP (HTTP/2). Con `auto` prueba QUIC y cae a HTTP/2, pero si la red del servidor bloquea UDP de salida conviene fijarlo. En el `.env` del servidor:

```bash
TUNNEL_TRANSPORT_PROTOCOL=http2
```

y `docker compose --profile tunnel up -d cloudflared`. Si también está bloqueado TCP 7844, el túnel no puede conectar.

**SSH por Cloudflare: `websocket: bad handshake` o cierra la conexión al tiro.** Falta la sesión de Access (corre `cloudflared access login https://ssh.tudominio.cl`), tu correo no está en la política, o la ruta `ssh.<dominio>` no es de tipo SSH.

**SSH por Cloudflare: conecta a Access pero no al servidor (timeout o connection refused).** cloudflared no llega al `sshd` del host. Prueba desde la red de compose:

```bash
docker run --rm --network phack2026_default --add-host host.docker.internal:host-gateway \
  busybox nc -zv -w 3 host.docker.internal 22
```

Si falla: `sshd` escucha solo en la IP de Tailscale (ver el paso 3.2), o el firewall del servidor bloquea el tráfico desde los contenedores. En Fedora con firewalld, revisa en qué zona quedaron las interfaces de Docker (`sudo firewall-cmd --get-active-zones`) y que esa zona permita `ssh`.

**El video se congela o va atrasado por el túnel.** Los playlists HLS (`.m3u8`) no deben quedar en la caché de Cloudflare. Caddy ya les pone `Cache-Control: no-store` (`infra/caddy/Caddyfile`) y Cloudflare no cachea `.m3u8` por defecto. Revisa que no tengas una **Cache Rule** del dominio del tipo "Cache Everything" que cubra `/live/*`. Con `curl -sSI https://arena.tudominio.cl/live/arena/index.m3u8`, la cabecera `cf-cache-status` debe decir `DYNAMIC` o `BYPASS`, nunca `HIT`.

**El websocket no conecta.** Cloudflare deja pasar websockets por defecto (en el dominio: **Network → WebSockets** activado). Caddy ya hace el upgrade hacia el orquestador.

**El script de despliegue dice que falta `TUNNEL_TOKEN`.** El `.env` del servidor no tiene la línea `TUNNEL_TOKEN=eyJ...`. Agrégala en el servidor (paso 2.2).
