# Espaco Serena Backend

API Node.js para login admin real com JWT e armazenamento SQLite.

## 1) Instalar

```bash
cd d:\espaco-serena-backend
npm install
```

## 2) Configurar variaveis

```bash
copy .env.example .env
```

Opcional: alterar `JWT_SECRET` para um segredo forte.

## 2FA Telegram: criar e ligar bot

1. No Telegram, abre `@BotFather`.
2. Envia `/newbot` e escolhe nome + username (a terminar em `bot`).
3. Guarda o token do bot (`TELEGRAM_BOT_TOKEN`).
4. Envia uma mensagem ao teu bot (ex.: "ola").
5. Descobre o `chat_id`:

```bash
npm run tg:updates -- <TELEGRAM_BOT_TOKEN>
```

6. Testa envio:

```bash
npm run tg:send -- <TELEGRAM_BOT_TOKEN> <CHAT_ID> "teste 2fa"
```

7. Configura no `.env`:

```env
ADMIN_2FA_ENABLED=true
ADMIN_2FA_ALLOW_CONSOLE_FALLBACK=false
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

8. Reinicia o backend.

Com `ADMIN_2FA_ALLOW_CONSOLE_FALLBACK=false`, o codigo 2FA e obrigatoriamente enviado por Telegram; se Telegram falhar, o login admin com 2FA falha.

## 3) Iniciar servidor

```bash
npm start
```

Servidor em `http://localhost:4000`.

## Endpoints principais

- `POST /api/auth/login`
- `POST /api/admin/2fa/verify`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`
- `POST /api/client/register`
- `POST /api/client/login`
- `GET /api/client/dashboard` (cliente autenticado)
- `GET /api/client/promotions` (cliente autenticado)
- `GET /api/client/premium-services` (cliente autenticado)
- `POST /api/client/bookings` (cliente autenticado)
- `POST /api/client/messages` (cliente autenticado)
- `POST /api/bookings`
- `POST /api/messages`
- `GET /api/admin/overview` (admin autenticado)
- `DELETE /api/admin/data` (admin autenticado)

Fluxo admin com 2FA Telegram:

- `POST /api/auth/login` valida email/password do admin.
- Se `ADMIN_2FA_ENABLED=true`, devolve `202` com `requires2fa`, `challengeId` e `tempToken`.
- O codigo OTP (6 digitos) e enviado ao Telegram configurado.
- `POST /api/admin/2fa/verify` (ou aliases) valida `token/code/otp` + `challengeId` e devolve:

- `accessToken` (curta duracao)
- `refreshToken` (rotativo, guardado na BD)

Com `ADMIN_2FA_ENABLED=false`, `/api/auth/login` retorna diretamente:

- `accessToken` (curta duracao)
- `refreshToken` (rotativo, guardado na BD)

O frontend usa `refreshToken` para renovar sessao sem novo login e usa `logout` para revogar refresh token no servidor.

Regras de acesso:

- Visitantes (nao registados) podem usar `POST /api/bookings` e `POST /api/messages`.
- Apenas clientes autenticados acedem a promocoes e servicos premium.
- Apenas admin autenticado acede ao dashboard administrativo global.

## Credenciais admin

Define no ficheiro `.env`:

- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`

Nao uses credenciais padrao em producao.

## Seguranca recomendada

- Define `JWT_SECRET` e `PASSWORD_SALT` com valores fortes.
- Define `FRONTEND_ORIGIN` com o dominio real do frontend.
- Define `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID` para ativar envio real do OTP.
- Nao comites `.env` nem `serena.db`.

## Deploy

Instrucoes detalhadas em `DEPLOY.md` para Render, Railway e VPS com HTTPS.

## Runbook rapido (producao)

Usa esta ordem sempre que houver alteracoes para evitar erros de OTP apos publicar no GitHub:

1. Render > Environment
- `ADMIN_EMAIL` e `ADMIN_PASSWORD` definidos.
- `ADMIN_2FA_ENABLED=true`.
- `ADMIN_2FA_ALLOW_CONSOLE_FALLBACK=false` para obrigar Telegram real.
- `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID` atualizados.

2. Telegram
- Envia `/start` ao bot.
- Valida o chat id com `npm run tg:updates -- <TOKEN>` e confirma que bate com `TELEGRAM_CHAT_ID`.

3. Deploy
- Fazer push para `main`.
- Confirmar no Render que o deploy terminou e `GET /api/health` responde `ok:true`.

4. Frontend admin
- Abrir `admin-acesso.html` com refresh forcado (`Ctrl+F5`).
- Se necessario, usar o botao `Usar API de producao` no proprio ecrã para fixar o endpoint certo.

5. Teste final OTP
- `Recuperar password` > `Pedir OTP no Telegram`.
- Confirmar rececao do codigo no Telegram.
- Validar OTP e entrar no admin.

## PostgreSQL (migracao de dados)

Este projeto continua a correr com SQLite por defeito, mas ja inclui utilitario para migrar dados para PostgreSQL.

1. Define `DATABASE_URL` no `.env`.
2. Cria schema no Postgres (automatico no script).
3. Executa:

```bash
npm run db:pg:migrate
```

O script importa dados de `DB_PATH` (SQLite) para PostgreSQL usando `db/schema.postgres.sql`.
