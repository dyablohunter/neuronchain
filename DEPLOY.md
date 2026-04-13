# NeuronChain Production Deployment Guide

## Overview

NeuronChain consists of two parts:
1. **Static frontend** - the built `dist/` folder (HTML/JS/CSS + face-api.js models)
2. **Gun relay server** - a Node.js process that handles WebSocket P2P sync

Both can run on the same server or be split across multiple servers for scale.

---

## Option 1: Single Server (Simplest)

A single VPS running nginx + Gun relay. Good for up to ~1,000 concurrent nodes.

### Requirements

- VPS with Node.js 18+ (e.g., DigitalOcean $5/mo droplet, AWS Lightsail, Hetzner)
- A domain name (e.g., `neuronchain.example.com`)
- Port 80/443 open

### Step 1: Build the frontend

```bash
git clone https://github.com/dyablohunter/neuronchain.git
cd neuronchain
npm install
npm run build
```

This creates a `dist/` folder with the static site.

### Step 2: Create the production Gun relay

Create `server.cjs` in the project root:

```javascript
const Gun = require('gun');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8765;
const DIST = path.join(__dirname, 'dist');

const server = http.createServer((req, res) => {
  // CORS for Gun
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // Serve static files from dist/
  let filePath = path.join(DIST, req.url === '/' ? 'index.html' : req.url);
  if (!fs.existsSync(filePath)) filePath = path.join(DIST, 'index.html'); // SPA fallback

  const ext = path.extname(filePath);
  const mimeTypes = {
    '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
    '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2', '.woff': 'font/woff',
  };

  res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

// Attach Gun relay
Gun({ web: server, file: 'relay-data' });

server.listen(PORT, '0.0.0.0', () => {
  console.log(`NeuronChain server running on port ${PORT}`);
});
```

### Step 3: Configure nginx (HTTPS reverse proxy)

Install nginx and certbot:

```bash
sudo apt update && sudo apt install nginx certbot python3-certbot-nginx -y
```

Create `/etc/nginx/sites-available/neuronchain`:

```nginx
server {
    listen 80;
    server_name neuronchain.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name neuronchain.example.com;

    ssl_certificate /etc/letsencrypt/live/neuronchain.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/neuronchain.example.com/privkey.pem;

    # Gun WebSocket relay
    location /gun {
        proxy_pass http://127.0.0.1:8765;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;
    }

    # Static files
    location / {
        proxy_pass http://127.0.0.1:8765;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Enable the site and get SSL:

```bash
sudo ln -s /etc/nginx/sites-available/neuronchain /etc/nginx/sites-enabled/
sudo certbot --nginx -d neuronchain.example.com
sudo nginx -t && sudo systemctl reload nginx
```

### Step 4: Run the server

```bash
node server.cjs
```

For production, use PM2 to keep it running:

```bash
npm install -g pm2
pm2 start server.cjs --name neuronchain
pm2 save
pm2 startup  # auto-start on reboot
```

### Step 5: Update the relay URL

In `src/network/gun-network.ts`, the `getRelayUrl()` function auto-detects the origin. Since nginx proxies `/gun` to the Gun relay, no code changes needed - it just works.

For a custom relay URL, set it explicitly:

```typescript
function getRelayUrl(): string {
  return 'https://neuronchain.example.com/gun';
}
```

Then rebuild: `npm run build`

---

## Option 2: Docker

### Dockerfile

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY dist/ dist/
COPY server.cjs .
EXPOSE 8765
CMD ["node", "server.cjs"]
```

### Build and run

```bash
npm run build
docker build -t neuronchain .
docker run -d -p 8765:8765 -v neuronchain-data:/app/relay-data --name neuronchain neuronchain
```

### Docker Compose with nginx

```yaml
version: '3.8'
services:
  neuronchain:
    build: .
    volumes:
      - relay-data:/app/relay-data
    restart: unless-stopped

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/conf.d/default.conf
      - certs:/etc/letsencrypt
    depends_on:
      - neuronchain
    restart: unless-stopped

volumes:
  relay-data:
  certs:
```

---

## Option 3: Multi-Server (Scale)

For high throughput, split the Gun relay across multiple servers:

```
                    Load Balancer (nginx/Cloudflare)
                    ├── /gun → Gun Relay Cluster
                    └── /*   → Static CDN (Cloudflare Pages, Vercel, etc.)

Gun Relay Cluster:
  ├── relay-1.example.com  (handles shard 0 + 1)
  ├── relay-2.example.com  (handles shard 2 + 3)
  └── relay-3.example.com  (handles global: accounts, votes, peers)
```

### Dedicated relay server

Each relay server runs a minimal Gun relay:

```javascript
const Gun = require('gun');
const http = require('http');

const PORT = process.env.PORT || 8765;
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.writeHead(200);
  res.end('NeuronChain Relay');
});

Gun({ web: server, file: 'relay-data' });
server.listen(PORT, '0.0.0.0');
```

### Frontend configuration

Update `gun-network.ts` to connect to multiple relay servers:

```typescript
const RELAY_URLS = [
  'https://relay-1.example.com/gun',
  'https://relay-2.example.com/gun',
  'https://relay-3.example.com/gun',
];
```

Gun will sync data across all connected relays automatically.

---

## Option 4: Serverless / Static Hosting

Deploy the frontend to any static host. Use a managed Gun relay.

### Frontend: Cloudflare Pages / Vercel / Netlify

```bash
npm run build
# Deploy dist/ to your static host
```

### Gun Relay: Railway / Fly.io / Render

Deploy `server.cjs` (relay only, no static serving) to any Node.js host:

**Fly.io:**
```bash
fly launch
fly deploy
```

**Railway:**
Push to GitHub → connect Railway → auto-deploys.

**Render:**
Create a new Web Service → point to repo → set start command to `node server.cjs`.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8765` | Gun relay server port |

---

## Face-API.js Models

The `dist/models/` directory contains the face recognition model weights (~7MB). These must be served alongside the app. If using a CDN, ensure the models are included in the deployment.

The models are:
- `tiny_face_detector_model-*` - face detection
- `face_landmark_68_model-*` - facial landmarks
- `face_recognition_model-*` - 128-D face descriptors

---

## Security Checklist

- [ ] HTTPS enabled (Let's Encrypt or equivalent)
- [ ] WebSocket upgrade configured in nginx (`proxy_set_header Upgrade`)
- [ ] `proxy_read_timeout` set high for WebSocket (86400 = 24h)
- [ ] CORS headers set on Gun relay
- [ ] Firewall: only ports 80/443 open publicly
- [ ] Gun relay data directory backed up (`relay-data/`)
- [ ] PM2 or systemd for process management
- [ ] Rate limiting on nginx (optional, prevents DoS)

---

## Monitoring

### PM2

```bash
pm2 monit          # Live dashboard
pm2 logs           # View logs
pm2 status         # Process status
```

### Health check

```bash
curl https://neuronchain.example.com/gun
# Should return: "NeuronChain Gun Relay OK" or similar
```

### Disk usage

Gun stores data in `relay-data/`. Monitor disk usage:

```bash
du -sh relay-data/
```

---

## Scaling Notes

| Nodes | Recommended Setup |
|-------|-------------------|
| 1-100 | Single $5 VPS |
| 100-1,000 | Single $20 VPS with SSD |
| 1,000-10,000 | 2-3 relay servers behind load balancer |
| 10,000+ | Multiple relay clusters + CDN for static assets |

The block-lattice DAG with optimistic confirmation means throughput scales with the number of active accounts, not the number of nodes. The relay is the bottleneck - add more relay servers for more capacity.

---

## Updating

```bash
cd neuronchain
git pull
npm install
npm run build
pm2 restart neuronchain
```

The Gun relay preserves data across restarts. No migration needed for frontend-only updates.
