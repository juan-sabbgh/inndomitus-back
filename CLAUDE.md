# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the App

```bash
npm install
node app.js
```

No build step. No lint or test scripts are configured.

## Architecture

Single-file Express.js REST API (`app.js`). All logic lives in that one file — no separate modules or subdirectories.

**Endpoints:**
- `POST /api/formulario-contacto` — Contact form; sends an HTML email via Gmail SMTP
- `POST /api/configuracion-agente` — Agent configuration submission; logs data and returns confirmation

**Middleware stack:** CORS (whitelist from env) → JSON body parser → general rate limiter (100 req/15min) → per-endpoint rate limiters (10 req/hr)

**Email:** Nodemailer over `smtp.gmail.com:587` (STARTTLS). Timestamps use `America/Mexico_City` timezone.

## Environment Variables

All required — no defaults except `PORT`:

| Variable | Description |
|---|---|
| `PORT` | Server port (default: 3000) |
| `EMAIL_USER` | Gmail address for SMTP auth |
| `EMAIL_PASSWORD` | Gmail app password |
| `EMAIL_TO` | Recipient for contact form emails |
| `CORS_ORIGIN` | Comma-separated list of allowed origins |
| `GEMINI_API_KEY` | Google Gemini API key |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token |
