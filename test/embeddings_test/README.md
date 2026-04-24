# Embeddings Live Tests

Run these tests only with real credentials available in `.env`.

```bash
LIVE_TESTS=1 pnpm test:embeddings:live
```

Included coverage:

- Gemini text embedding smoke
- Postgres-backed dense retrieval smoke built on `client.embed()`
- Optional PDF embedding smoke behind `GEMINI_EMBEDDING_PDF_LIVE=1`

The PDF smoke remains separately gated because file/document embedding support is the most provider-sensitive path.
