FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node server/ server/
COPY --chown=node:node web/ web/
COPY --chown=node:node esp32_led_control.html ./
USER node
ENV HOST=0.0.0.0 PORT=8000
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/server.mjs"]
