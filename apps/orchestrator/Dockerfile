# El contexto de build es la RAÍZ del repo:
#   docker build -f apps/orchestrator/Dockerfile .
#
# Node 22 (no 20): los agentes corren dentro de este proceso con mineflayer, y las
# versiones actuales de mineflayer / minecraft-protocol declaran "engines": node >= 22.
FROM node:22-slim

WORKDIR /repo
RUN npm i -g pnpm@10

COPY . .

# Aún no hay lockfile, así que no se usa --frozen-lockfile.
# El filtro "..." instala solo el orquestador y sus dependencias del workspace.
RUN pnpm install --filter "@phack/orchestrator..."

ENV NODE_ENV=production
EXPOSE 8787

CMD ["pnpm", "--filter", "@phack/orchestrator", "start"]
