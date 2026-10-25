FROM node:24-alpine
ENV NODE_ENV=production
# Tools the WOUTR-WP commands need (ssh/scp, gh, unzip, curl) plus git/git-lfs for the checkout.
RUN apk add --no-cache bash git git-lfs openssh-client unzip curl github-cli \
  && mkdir -p /data/ssh && chown -R node:node /data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY views ./views
COPY public ./public
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
