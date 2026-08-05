# Deployment Guide

## Prerequisites

- Docker and Docker Compose (v2+)
- (Optional) A Gemini API key for AI-powered dispatch briefs

## Local Deployment

```bash
# 1. Clone the repository
git clone <repo-url>
cd assignment

# 2. Copy environment template
cp .env.example .env

# 3. (Optional) Add your Gemini API key to .env
#    GEMINI_API_KEY=your-key-here

# 4. Start everything
docker compose up --build -d

# 5. Wait for seeding to complete (~30s)
docker compose logs -f backend
# Look for: "✓ Backend running on port 3001"

# 6. Access
#    Frontend:  http://localhost:5173
#    Backend:   http://localhost:3001/api/health
```

## Environment Variables

| Variable | Default | Description | Required |
|----------|---------|-------------|----------|
| `POSTGRES_DB` | faultdb | Database name | Yes |
| `POSTGRES_USER` | faultuser | DB username | Yes |
| `POSTGRES_PASSWORD` | faultpass | DB password | Yes |
| `DB_PORT` | 5433 | External DB host port | Yes |
| `BACKEND_PORT` | 3001 | Backend API port | Yes |
| `FRONTEND_PORT` | 5173 | Frontend web port | Yes |
| `NODE_ENV` | production | Runtime environment | Yes |
| `GEMINI_API_KEY` | (empty) | Gemini API key for AI dispatch briefs | Optional |

---

## Troubleshooting Guide

| Issue / Symptom | Cause | Solution / Fix |
|-----------------|-------|----------------|
| `Bind for 0.0.0.0:5432 (or 3001) failed: port is already allocated` | Local PostgreSQL or another dev server is occupying port 5432/3001 on the host machine. | Change `DB_PORT=5433` or `BACKEND_PORT=3002` in `.env`, or stop local service (`docker stop assignment-db-1`). |
| `db: postgresql connection refused` during startup | Backend container started before PostgreSQL finished initializing database. | `docker-compose.yml` uses `depends_on` with `condition: service_healthy` on `pg_isready`. Run `docker compose restart backend` if DB cold-started. |
| `exec format error` on container start | Mismatch between build host architecture (Apple M-series ARM64 vs x86 Linux). | Dockerfiles use base image `node:20-alpine` which has multi-architecture support. Rebuild using `docker compose build --no-cache`. |
| WebSocket connection failed / CORS error on deployed public URL | Frontend attempting to connect to `localhost:3001` instead of the public server URL. | Pass `VITE_API_URL` and `VITE_WS_URL` build args matching your public server domain during build or set them in `.env`. |
| Container killed with exit code 137 (OOM) | Deployment server hit memory limits during database seeding or build. | Add Node memory cap `NODE_OPTIONS="--max-old-space-size=512"` in environment or increase VPS RAM. |
| Cold-start timeout on free tier (e.g. Render / Railway) | Free tier instances sleep after inactivity and take 30-40 seconds to wake up. | Mentioned in README; initial load requires waiting ~30s for container wake-up. Hit `/api/health` first. |

---

## Stopping & Resetting to Clean State

```bash
# Stop running containers
docker compose down

# Reset database & volume to clean state (forces re-seeding on next start)
docker compose down -v

# Re-start from scratch
docker compose up --build -d
```

