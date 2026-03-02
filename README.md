# Perishless

Perishless is a food-waste reduction platform built at **HenHacks 2026**.  
It combines a modern web app with AI-assisted tooling to help users track food, make smarter decisions, and waste less.

## Links

- **Live Site:** https://perishless.tech
- **Devpost:** https://devpost.com/software/perishless?ref_content=my-projects-tab&ref_feature=my_projects

## What this project includes

- **Frontend:** React + Vite (TypeScript)
- **Backend:** Python FastAPI service
- **Infra:** Docker + Docker Compose setup for local development

## Repository structure

```text
Perishless/
├── backend/            # FastAPI app, data + AI/service integrations
├── frontend/           # React/Vite web app
├── docker-compose.yml  # Local multi-service orchestration
└── README.md
```

## Getting started

### Option 1: Docker (recommended)

1. From the repo root, make sure your root `.env` file is configured.
2. Start services:

	```bash
	docker compose up --build
	```

3. Open:
	- Frontend: http://localhost:3000
	- Backend: http://localhost:8000

### Option 2: Run services manually

#### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8000 --reload
```

#### Frontend

```bash
cd frontend
npm install
npm run dev
```

## Environment configuration

- Root `.env` is used by Docker Compose.
- Frontend Vite variables can live in `frontend/.env`.
- Keep secrets out of commits when possible (prefer local-only env files / secret managers).

## Team / Event

Built for **HenHacks 2026** as part of a mission to reduce household food waste using accessible technology.
