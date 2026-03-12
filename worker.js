/**
 * Multimodal RAG Worker
 * Stack: Cloudflare Workers + KV + D1 + Vectorize + Workers AI + Gemini
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    try {
      if (path === '/api/ingest' && request.method === 'POST') {
        return await handleIngest(request, env);
      }
      if (path === '/api/search' && request.method === 'POST') {
        return await handleSearch(request, env);
      }
      if (path === '/api/files' && request.method === 'GET') {
        return await handleListFiles(env);
      }
      if (path === '/api/delete-file' && request.method === 'DELETE') {
        return await handleDeleteFile(request, env);
      }
      if (path === '/api/health' && request.method === 'GET') {
        return jsonResponse({ status: 'ok', timestamp: new Date().toISOString() });
      }

      return new Response('Not found', { status: 404, headers: CORS_HEADERS });
    } catch (err) {
      console.error('Worker error:', err);
      return jsonResponse({ error: err.message || 'Internal server error' }, 500);
    }
  },
};

// ─────────────────────────────────────────────────────────────────
// INGEST
// ─────────────────────────────────────────────────────────────────
async function handleIngest(request, env) {
  const body = await request.json();
  const { imageBase64, mimeType = 'image/jpeg', fileName, pageNumber, totalPages } = body;

  if (!imageBase64 || !fileName) {
    return jsonResponse({ error: 'Missing imageBase64 or fileName' }, 400);
  }

  // 1. Describe page with Gemini Vision
  const description = await describePageWithGemini(imageBase64, mimeType, env.GEMINI_API_KEY);

  // 2. Generate embedding
  const embedding = await generateEmbedding(description, env.AI);

  // 3. Store image in KV as base64 string (no R2 needed)
  const pageId = `${sanitizeFileName(fileName)}_p${pageNumber}_${Date.now()}`;
  const kvKey = `${pageId}.jpg`;

  await env.PAGES_BUCKET.put(kvKey, imageBase64);

  // 4. Store metadata in D1
  await env.DB.prepare(`
    INSERT INTO pages (id, file_name, page_number, total_pages, description, r2_key)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(pageId, fileName, pageNumber, totalPages, description, kvKey).run();

  // 5. Upsert into Vectorize
  await env.VECTORIZE.upsert([
    {
      id: pageId,
      values: embedding,
      metadata: {
        fileName,
        pageNumber,
        totalPages,
        description: description.slice(0, 512),
      },
    },
  ]);

  return jsonResponse({ success: true, id: pageId, description });
}

// ─────────────────────────────────────────────────────────────────
// SEARCH
// ─────────────────────────────────────────────────────────────────
async function handleSearch(request, env) {
  const body = await request.json();
  const { query, topK = 6 } = body;

  if (!query || query.trim().length === 0) {
    return jsonResponse({ error: 'Query is required' }, 400);
  }

  const queryEmbedding = await generateEmbedding(query, env.AI);

  const vectorResults = await env.VECTORIZE.query(queryEmbedding, {
    topK,
    returnMetadata: 'all',
  });

  if (!vectorResults.matches || vectorResults.matches.length === 0) {
    return jsonResponse({ results: [], summary: 'No matching pages found. Try uploading some files first!' });
  }

  const results = await Promise.all(
    vectorResults.matches.map(async (match) => {
      const page = await env.DB.prepare('SELECT * FROM pages WHERE id = ?')
        .bind(match.id)
        .first();

      if (!page) return null;

      // FIX 1: was missing 'const', had a stray closing brace
      const imageBase64 = await env.PAGES_BUCKET.get(page.r2_key);

      return {
        id: match.id,
        score: Math.round(match.score * 1000) / 1000,
        fileName: page.file_name,
        pageNumber: page.page_number,
        totalPages: page.total_pages,
        description: page.description,
        imageBase64,
        mimeType: 'image/jpeg',
      };
    })
  );

  const validResults = results.filter(Boolean);
  const summary = await generateSearchSummary(query, validResults, env.GEMINI_API_KEY);

  return jsonResponse({ results: validResults, summary, query });
}

// ─────────────────────────────────────────────────────────────────
// LIST FILES
// ─────────────────────────────────────────────────────────────────
async function handleListFiles(env) {
  const result = await env.DB.prepare(`
    SELECT
      file_name,
      COUNT(*) as page_count,
      MAX(created_at) as uploaded_at
    FROM pages
    GROUP BY file_name
    ORDER BY uploaded_at DESC
  `).all();

  return jsonResponse({ files: result.results || [] });
}

// ─────────────────────────────────────────────────────────────────
// DELETE FILE
// ─────────────────────────────────────────────────────────────────
async function handleDeleteFile(request, env) {
  const { fileName } = await request.json();
  if (!fileName) return jsonResponse({ error: 'fileName required' }, 400);

  const pages = await env.DB.prepare('SELECT id, r2_key FROM pages WHERE file_name = ?')
    .bind(fileName)
    .all();

  const rows = pages.results || [];

  await Promise.all([
    ...rows.map((r) => env.PAGES_BUCKET.delete(r.r2_key)),
    rows.length > 0
      ? env.VECTORIZE.deleteByIds(rows.map((r) => r.id))
      : Promise.resolve(),
    env.DB.prepare('DELETE FROM pages WHERE file_name = ?').bind(fileName).run(),
  ]);

  return jsonResponse({ success: true, deletedPages: rows.length });
}

// ─────────────────────────────────────────────────────────────────
// AI HELPERS
// ─────────────────────────────────────────────────────────────────
async function describePageWithGemini(imageBase64, mimeType, apiKey) {
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY secret not set.');
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { inline_data: { mime_type: mimeType, data: imageBase64 } },
              {
                text: `You are a study notes analyzer. Analyze this page and provide a comprehensive, searchable description covering:
1. Main topic/concept/subject (the PRIMARY concept this page is about)
2. All key terms, vocabulary, and technical jargon present
3. Any definitions, formulas, equations, or rules shown
4. What diagrams, charts, or visual elements depict (describe their content)
5. Any examples, case studies, or applications mentioned
6. Sub-topics and related concepts covered

Be extremely detailed and use the actual terminology from the page. Your description will be used for semantic search, so include all synonyms and related terms. Write as a dense, information-rich paragraph.`,
              },
            ],
          },
        ],
        generationConfig: { maxOutputTokens: 1024, temperature: 0.1 },
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API error: ${response.status} — ${err}`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Page content could not be analyzed.';
}

async function generateEmbedding(text, ai) {
  const result = await ai.run('@cf/baai/bge-base-en-v1.5', {
    text: [text.slice(0, 2048)],
  });
  return result.data[0];
}

async function generateSearchSummary(query, results, apiKey) {
  if (!apiKey || results.length === 0) return '';

  const context = results
    .slice(0, 4)
    .map((r) => `[${r.fileName}, Page ${r.pageNumber}]: ${r.description}`)
    .join('\n\n');

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: `A student searched for: "${query}"

Here are the most relevant pages found in their notes:
${context}

Write a helpful 2-3 sentence summary that directly answers what the student is looking for, synthesizing information from these pages. Be concise and educational.`,
              },
            ],
          },
        ],
        generationConfig: { maxOutputTokens: 300, temperature: 0.3 },
      }),
    }
  );

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ─────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function sanitizeFileName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 50);
}