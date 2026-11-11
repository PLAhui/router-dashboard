# Router Dashboard —— 零依赖，镜像极小
FROM node:22-alpine

WORKDIR /app

# 仅复制运行所需文件（config.env 不进镜像，密码通过 -e 环境变量注入）
COPY package.json server.js analytics.js ./
COPY public ./public

# 容器内必须监听 0.0.0.0 才能被端口映射访问
ENV NODE_ENV=production \
    BIND=0.0.0.0 \
    PORT=8787

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8787/api/health >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
