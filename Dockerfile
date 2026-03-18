FROM node:22-slim

WORKDIR /app

RUN npm install -g perp-cli@latest

ENTRYPOINT ["perp-mcp"]
