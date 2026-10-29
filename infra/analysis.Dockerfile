# Microservice d'analyse : binaire Stockfish NATIF (pas WASM) — 3 à 5× plus rapide côté serveur.
# Épinglez la version : un rapport anti-triche doit pouvoir être rejoué à l'identique.
FROM node:22-bookworm-slim AS sf
# Stockfish 19 (sept. 2026) est distribué en binaires "universels" (détection CPU auto).
# ⚠ Vérifier le nom exact de l'asset Linux sur github.com/official-stockfish/Stockfish/releases/tag/sf_19
ARG STOCKFISH_TAG=sf_19
ARG STOCKFISH_ASSET=stockfish-ubuntu-x86-64.tar
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates tar && \
    curl -fsSL -o /tmp/sf.tar "https://github.com/official-stockfish/Stockfish/releases/download/${STOCKFISH_TAG}/${STOCKFISH_ASSET}" && \
    mkdir -p /opt/sf && tar -xf /tmp/sf.tar -C /opt/sf && \
    find /opt/sf -type f -name 'stockfish-*' -perm -u+x -exec cp {} /usr/local/bin/stockfish \;

FROM node:22-bookworm-slim
COPY --from=sf /usr/local/bin/stockfish /usr/local/bin/stockfish
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY db ./db
COPY services/analysis ./services/analysis
RUN npm ci --workspace @chessarena/analysis --include-workspace-root
ENV STOCKFISH_CMD=/usr/local/bin/stockfish PORT=4100
EXPOSE 4100
CMD ["npm", "run", "start", "-w", "@chessarena/analysis"]
