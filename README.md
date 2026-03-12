# 🔍 NoteSearch — Multimodal RAG for Study Notes

Search any concept across all your notes using AI vision. Powered by **Gemini 1.5 Flash** (vision) + **Cloudflare Vectorize** (search) + **Cloudflare Workers AI** (embeddings).

---

## Architecture

```
Browser (PDF → Images)
    │
    ▼
Cloudflare Worker (API)
    ├── Gemini 1.5 Flash ──── Describe page visually
    ├── CF Workers AI ──────── Generate embeddings (free)
    ├── Cloudflare R2 ──────── Store page images
    ├── Cloudflare D1 ──────── Store metadata (SQLite)
    └── Cloudflare Vectorize ── Semantic vector search
```

---

## Prerequisites

- **Node.js 18+** and npm
- **Cloudflare account** (free tier works!)
- **Google AI Studio API key** (free) — [get one here](https://aistudio.google.com/app/apikey)

---

## Setup (Step-by-Step)

### 1. Install dependencies

```bash
npm install
```

### 2. Login to Cloudflare

```bash
npx wrangler login
```

### 3. Create R2 bucket

```bash
npx wrangler r2 bucket create rag-pages
```

### 4. Create D1 database

```bash
npx wrangler d1 create rag-metadata
```

Copy the `database_id` from the output and paste it into `wrangler.toml`:
```toml
[[d1_databases]]
binding = "DB"
database_name = "rag-metadata"
database_id = "PASTE_YOUR_ID_HERE"   # ← replace this
```

### 5. Create Vectorize index

```bash
npx wrangler vectorize create rag-index --dimensions=768 --metric=cosine
```

> **Important:** `bge-base-en-v1.5` produces **768-dimensional** embeddings. This must match.

### 6. Initialize the D1 schema

```bash
# Local (for dev)
npm run setup-db

# Production (after deploying)
npm run setup-db-remote
```

### 7. Set your Gemini API key

```bash
npx wrangler secret put GEMINI_API_KEY
# Paste your key when prompted
```

Get a free key at: https://aistudio.google.com/app/apikey

### 8. Deploy!

```bash
npm run deploy
```

Your app will be live at: `https://multimodal-rag.<your-subdomain>.workers.dev`

---

## Local Development

```bash
npm run dev
```

For local dev, Vectorize and D1 bindings are simulated. You'll need to run the D1 schema setup first.

---

## How It Works

### Ingestion Flow
1. **User uploads PDF** → Browser uses pdf.js to render each page to a canvas
2. **Page → JPEG** → Each page becomes a JPEG image (2x scale for quality)
3. **POST /api/ingest** → Worker receives the base64 image
4. **Gemini Vision** → Analyzes the page: extracts concepts, terms, formulas, diagram descriptions
5. **Embedding** → Description is embedded using `@cf/baai/bge-base-en-v1.5` (free, 768-dim)
6. **Storage** → Image stored in R2, metadata in D1, vector in Vectorize

### Search Flow
1. **User types query** → e.g., "How does backpropagation work?"
2. **Embed query** → Same model embeds the query
3. **Vector search** → Vectorize returns top-K most similar page embeddings
4. **Fetch results** → D1 metadata + R2 images loaded for each result
5. **AI Summary** → Gemini synthesizes a helpful summary from top results
6. **Display** → Results shown as page screenshots with scores

---

## API Reference

### `POST /api/ingest`
Upload a page for indexing.

```json
{
  "imageBase64": "...",
  "mimeType": "image/jpeg",
  "fileName": "lecture-notes.pdf",
  "pageNumber": 1,
  "totalPages": 15
}
```

### `POST /api/search`
Semantic search across all indexed pages.

```json
{
  "query": "explain mitosis",
  "topK": 6
}
```

**Response:**
```json
{
  "results": [
    {
      "fileName": "biology-notes.pdf",
      "pageNumber": 7,
      "score": 0.89,
      "description": "...",
      "imageBase64": "..."
    }
  ],
  "summary": "AI-generated summary of findings..."
}
```

### `GET /api/files`
List all uploaded files.

### `DELETE /api/delete-file`
Delete all pages for a file.
```json
{ "fileName": "old-notes.pdf" }
```

---

## Cloudflare Free Tier Limits

| Service | Free Tier |
|---------|-----------|
| Workers | 100K requests/day |
| R2 | 10 GB storage, 1M reads/month |
| D1 | 5 GB storage, 25M reads/day |
| Vectorize | 5M queried vectors/month, 30M stored |
| Workers AI | included (bge-base-en-v1.5) |

**Gemini 1.5 Flash:** 15 requests/minute free, generous daily quota.

---

## Troubleshooting

**`database_id` missing?**
Run `wrangler d1 list` to find your database ID.

**Vectorize dimension mismatch?**
Delete and recreate the index with `--dimensions=768`.

**GEMINI_API_KEY not working?**
Ensure you set it as a Worker secret: `wrangler secret put GEMINI_API_KEY`

**PDF pages not rendering?**
pdf.js requires CORS-friendly server. Works fine on Cloudflare Pages/Workers.

---

## Tech Stack

- **Runtime:** Cloudflare Workers (V8 isolates, edge deployment)
- **Vision AI:** Google Gemini 1.5 Flash
- **Embeddings:** `@cf/baai/bge-base-en-v1.5` (Cloudflare Workers AI)
- **Vector DB:** Cloudflare Vectorize (cosine similarity, 768-dim)
- **Object Storage:** Cloudflare R2
- **Metadata DB:** Cloudflare D1 (SQLite at the edge)
- **Frontend:** Vanilla HTML/CSS/JS + pdf.js
- **PDF Processing:** pdf.js (client-side, no server needed)
