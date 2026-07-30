#!/bin/bash
set -e

echo "=== 1/5 临时 port-80 配置（给 certbot 用）==="
echo 'server { listen 80; server_name YOUR_RELAY_DOMAIN; location / { return 200 "ok"; } }' | sudo tee /etc/nginx/sites-available/YOUR_RELAY_DOMAIN > /dev/null
sudo ln -sf /etc/nginx/sites-available/YOUR_RELAY_DOMAIN /etc/nginx/sites-enabled/YOUR_RELAY_DOMAIN
sudo nginx -t && sudo systemctl reload nginx

echo "=== 2/5 签 Let's Encrypt 证书 ==="
sudo certbot --nginx -d YOUR_RELAY_DOMAIN --non-interactive --agree-tos --register-unsafely-without-email 2>&1 | tail -5

echo "=== 3/5 安装正式 WS 反代配置 ==="
sudo cp ~/agentlink/deploy/nginx-relay.conf /etc/nginx/sites-available/YOUR_RELAY_DOMAIN
sudo nginx -t && sudo systemctl reload nginx

echo "=== 4/5 安装 systemd 服务 ==="
sudo cp ~/agentlink/deploy/agentlink-relay.service /etc/systemd/system/agentlink-relay.service
sudo systemctl daemon-reload
sudo systemctl enable agentlink-relay
sudo systemctl restart agentlink-relay

echo "=== 5/5 健康检查 ==="
sleep 2
echo "local health:" && curl -s http://127.0.0.1:8787/health
echo ""
echo "https health:" && curl -s https://YOUR_RELAY_DOMAIN/health
echo ""
echo "relay status:" && sudo systemctl is-active agentlink-relay
