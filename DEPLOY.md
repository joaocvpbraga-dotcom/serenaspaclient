# Deploy Seguro (Render, Railway, VPS)

## Variaveis seguras (obrigatorias)

- `PORT=4000`
- `JWT_SECRET=<64+ chars aleatorios>`
- `ACCESS_TOKEN_TTL=15m`
- `REFRESH_TOKEN_TTL_DAYS=7`
- `FRONTEND_ORIGIN=https://teu-frontend.com`
- `ADMIN_EMAIL=joaocvpbraga@gmail.com`
- `ADMIN_PASSWORD=<password-forte-unica>`
- `PASSWORD_SALT=<32+ chars aleatorios>`

Nunca comitar `.env` no repositorio.

## Render

1. Subir este backend para GitHub.
2. Criar novo Web Service no Render e ligar ao repo.
3. O Render deteta `render.yaml` automaticamente.
4. Definir `FRONTEND_ORIGIN`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` no painel.
5. Deploy e validar `GET /api/health`.

HTTPS no Render vem por defeito no dominio `onrender.com`.

## Railway

1. Criar projeto e ligar repo.
2. Railway usa `railway.json` + `Dockerfile`.
3. Definir todas as env vars no painel do Railway.
4. Deploy e validar `GET /api/health`.

HTTPS no Railway e automatico no dominio publico.

## VPS (Ubuntu + Nginx + Certbot)

### 1) Build e run com PM2

```bash
npm install
npm start
```

Opcional com PM2:

```bash
npm install -g pm2
pm2 start server.js --name espaco-serena-backend
pm2 save
pm2 startup
```

### 2) Nginx reverse proxy

Exemplo `/etc/nginx/sites-available/espaco-serena`:

```nginx
server {
    listen 80;
    server_name api.teudominio.com;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Ativar e reiniciar:

```bash
sudo ln -s /etc/nginx/sites-available/espaco-serena /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### 3) HTTPS com Let's Encrypt

```bash
sudo apt update
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d api.teudominio.com
```

### 4) Frontend

No HTML, trocar `API_BASE` para o dominio HTTPS final, por exemplo:

```js
const API_BASE = "https://api.teudominio.com/api";
```

## Checklist de seguranca

- Rodar com `NODE_ENV=production`
- Limitar `FRONTEND_ORIGIN` ao dominio real
- Usar segredos fortes em `JWT_SECRET` e `PASSWORD_SALT`
- Renovar password admin em producao
- Fazer backup de `serena.db`
