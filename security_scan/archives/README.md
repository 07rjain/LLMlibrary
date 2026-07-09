# Security scan archives

Compressed Codex/Cursor security-scan evidence bundles.

Agents: see also `SECURITY.md`, `CLAUDE.md`, and `AGENTS.md` for the same pointers.

| Scan ID | Archive | SHA-256 | GitHub Release |
| --- | --- | --- | --- |
| `ee9e5c6_20260709T114052Z` | [`ee9e5c6_20260709T114052Z.tar.gz`](./ee9e5c6_20260709T114052Z.tar.gz) | [`ee9e5c6_20260709T114052Z.tar.gz.sha256`](./ee9e5c6_20260709T114052Z.tar.gz.sha256) (`9a3649f1f4be3751fde5ef3affa80248e0e02d97b31d897d2c4d275eac510233`) | [`security-scan-20260709`](https://github.com/07rjain/LLMlibrary/releases/tag/security-scan-20260709) |

Human-readable findings: [`../cursor_security_scan_report.md`](../cursor_security_scan_report.md)

Unpack locally:

```bash
tar -xzf ee9e5c6_20260709T114052Z.tar.gz
shasum -a 256 -c ee9e5c6_20260709T114052Z.tar.gz.sha256
```

Do not commit unpacked `ee9e5c6_*` directories; keep only the `.tar.gz` + `.sha256` here.
