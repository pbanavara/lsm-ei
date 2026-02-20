# NAVD: Scale Estimation

## Scenario

An enterprise or LLM company deploying NAVD as per-user memory for 100,000 users, each conversing ~30 minutes per day. Each user's data is sandboxed in their own `conversations.log` and `embeddings.arrow` files.

## Per-User Daily Volume

| Parameter | Estimate |
|---|---|
| Conversation duration | 30 min |
| Exchanges per session | ~25 |
| Avg tokens per exchange (user + assistant) | ~300 |
| Tokens per day | ~7,500 |
| Bytes per day (raw JSON with framing) | ~35 KB |
| Chunks per day (at 10KB boundary) | 3-4 |

## Per-User Accumulation

| Metric | 1 Year | 3 Years |
|---|---|---|
| `conversations.log` size | ~12.5 MB | ~37 MB |
| Embedding vectors | ~1,300 | ~4,000 |
| `embeddings.arrow` (1536D, float32) | ~8 MB | ~24 MB |
| Total per user | ~20.5 MB | ~61 MB |

## Per-Query Latency Breakdown

The read path: user sends a message, system retrieves relevant memory chunks.

| Step | Latency | Notes |
|---|---|---|
| Embed the query | 20-50 ms | API call to embedding model (network-bound) |
| Brute-force cosine similarity | < 0.1 ms | 1,300 vectors x 1536D dot product |
| mmap read from log | < 0.5 ms | Top-5 chunks x ~10KB = 50KB seek + read, OS page cache |
| LLM inference | 500-3,000 ms | The dominant cost by two orders of magnitude |
| **Total per query** | **~0.5-3 s** | Almost entirely LLM inference |

### Latency Contribution

```
NAVD retrieval:  ~51 ms   ███
LLM inference:     ~2000 ms ████████████████████████████████████████████████████████████████████
```

The retrieval system contributes < 51 ms. The bottleneck is, and will always be, the LLM call.

### Cosine Similarity Search Scaling

| Vectors per user | Search time | Equivalent usage |
|---|---|---|
| 1,300 | < 0.1 ms | 1 year |
| 4,000 | < 0.5 ms | 3 years |
| 10,000 | < 1 ms | ~8 years |
| 50,000 | < 10 ms | Theoretical upper bound |

Brute-force remains viable well beyond any realistic single-user accumulation.

## System-Level: 100,000 Users

### Concurrency Profile

| Parameter | Value |
|---|---|
| Total users | 100,000 |
| Active hours per day | ~16 |
| Session duration | 30 min |
| Peak concurrent users | 5,000-10,000 |
| Queries per active user per session | ~25 |
| Avg query interval per active user | ~72 sec |
| **Peak QPS to retrieval layer** | **70-140** |

### Storage Requirements

| Resource | Year 1 | Year 3 |
|---|---|---|
| Log files (100K users) | 1.25 TB | 3.7 TB |
| Arrow files (100K users) | 800 GB | 2.4 TB |
| **Total disk** | **~2 TB** | **~6 TB** |

Fits on a single NVMe drive in year 1. A small RAID array handles multi-year retention.

### Memory Pressure (Peak)

| Resource | Working Set | Notes |
|---|---|---|
| Hot Arrow files | 10K x 8 MB = **80 GB** | Concurrent users' embedding indexes |
| Log reads per query | 10K x 50 KB = **500 MB** | Top-5 chunks per query |
| **Total RAM needed** | **~80-128 GB** | Single server with 128-256 GB handles this |

OS page cache manages mmap'd files automatically. Inactive users' files get evicted naturally.

### Embedding Compute

| Metric | Value |
|---|---|
| Embedding calls at peak | 140/sec |
| OpenAI `text-embedding-3-small` rate limit | 3,000+/min |
| Headroom | ~3.5x over peak demand |
| Alternative: local GPU model | Single A10/L4 batch-processes this trivially |

### Context Window Budget

Modern LLMs offer 128K-200K token context windows. After reserving space for system prompt and current conversation:

| Retrieval Depth | Raw Bytes | Approx Tokens | Context Used |
|---|---|---|---|
| Top-5 chunks (50 KB) | 50 KB | ~14,000 | 7-10% |
| Top-10 chunks (100 KB) | 100 KB | ~28,000 | 14-20% |
| Top-20 chunks (200 KB) | 200 KB | ~57,000 | 28-40% |
| Max before pressure | ~230 KB | ~65,000 | ~45% |

Retrieving 5-20 chunks per query uses a small fraction of available context. There is ample room for deep memory retrieval without crowding out the active conversation.

## Operational Considerations

### File Descriptor Management

| Concern | Mitigation |
|---|---|
| 100K users x 2 files = 200K file descriptors | LRU fd cache; only keep active users' files open |
| Default `ulimit -n` is often 1024 | Raise to 65K+ or use fd pooling |

### Filesystem Layout

| Concern | Mitigation |
|---|---|
| 200K files in one directory | Shard by user ID prefix: `users/ab/ab3f.../` |
| Inode pressure | XFS or ext4 with `dir_index` handles this natively |

### Failure Modes

| Scenario | Impact | Recovery |
|---|---|---|
| Arrow file corruption | Search unavailable for that user | Rebuild from log + embedding model |
| Log file corruption | Partial data loss from corruption point | Append-only format limits blast radius to tail |
| Disk full | Writes fail | Alert + expand storage; reads continue |
| Embedding API outage | New chunks not indexed; writes to log continue | Backfill embeddings when API recovers |

The log is the source of truth. The Arrow file is a derived index that can always be rebuilt.

## Cost Drivers (Ranked)

| Rank | Cost Driver | Notes |
|---|---|---|
| 1 | LLM inference | 70-140 QPS to a large model dominates spend |
| 2 | Embedding API calls | 140/sec at peak; ~$0.02/1M tokens (cheap) |
| 3 | Compute (single server) | 128-256 GB RAM, NVMe storage |
| 4 | Storage | 2-6 TB; commodity NVMe pricing |
| 5 | NAVD retrieval logic | Negligible; brute-force dot product + file read |

The memory system itself is not a meaningful cost factor. Infrastructure spend is dominated by LLM inference, which NAVD has no control over and does not amplify.

## Summary

| Question | Answer |
|---|---|
| Does NAVD handle 100K users? | Yes, on a single server |
| What's the per-query retrieval latency? | < 51 ms |
| What dominates total latency? | LLM inference (500-3,000 ms) |
| When does brute-force search break? | Well beyond 50K vectors per user (~10 ms) |
| When do you need a vector database? | Millions of vectors per user, which implies decades of continuous use |
| Total Year 1 storage? | ~2 TB |
| Can it run without a database server? | Yes. Two flat files per user. No processes, no ports, no clusters |
