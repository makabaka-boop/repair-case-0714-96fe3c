# ---- 依赖层 ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install

# ---- 验收层（一次性服务 verify 的目标阶段）----
FROM node:20-alpine AS verify
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 小规模穷举 + 大夹具 Vitest、类型检查、生产构建、原生 4 秒性能自检
CMD ["npm", "run", "verify"]

# ---- 前端构建层 ----
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- 静态托管层 ----
FROM nginx:1.27-alpine AS web
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
