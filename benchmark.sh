#!/bin/bash
HOST="${1:-http://localhost:3033}"
CONCURRENCY="${2:-5}"
API_KEY="${API_KEY:?Set API_KEY env var}"
TOTAL=5
PAYLOAD='{"messages":[{"role":"user","content":"Say hello in one word"}]}'
now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }

echo "=== Codex Proxy Benchmark ==="
echo "Host: $HOST | Requests: $TOTAL | Concurrency: $CONCURRENCY"
echo ""

echo "--- Sequential ---"
seq_total=0
for i in $(seq 1 $TOTAL); do
  start=$(now_ms)
  status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$HOST/v1/chat/completions" \
    -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" -d "$PAYLOAD")
  end=$(now_ms); elapsed=$((end - start)); seq_total=$((seq_total + elapsed))
  echo "  #$i: ${elapsed}ms (HTTP $status)"
done
seq_avg=$((seq_total / TOTAL))
echo "Total: ${seq_total}ms | Avg: ${seq_avg}ms"
echo ""

echo "--- Concurrent ---"
tmpdir=$(mktemp -d)
con_start=$(now_ms)
for i in $(seq 1 $TOTAL); do
  ( start=$(now_ms)
    status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$HOST/v1/chat/completions" \
      -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" -d "$PAYLOAD")
    end=$(now_ms); echo "$((end - start))" > "$tmpdir/$i"
    echo "  #$i: $((end - start))ms (HTTP $status)"
  ) &
  (( i % CONCURRENCY == 0 )) && wait
done
wait
con_end=$(now_ms); con_wall=$((con_end - con_start))
con_total=0
for f in "$tmpdir"/*; do con_total=$((con_total + $(cat "$f"))); done
con_avg=$((con_total / TOTAL)); rm -rf "$tmpdir"
echo "Wall: ${con_wall}ms | Avg: ${con_avg}ms"
echo ""

echo "=== Summary ==="
echo "Sequential: ${seq_total}ms total, ${seq_avg}ms avg"
echo "Concurrent: ${con_wall}ms wall, ${con_avg}ms avg"
[ "$con_wall" -gt 0 ] 2>/dev/null && echo "Speedup: $(echo "scale=1; $seq_total / $con_wall" | bc)x"
echo ""
curl -s "$HOST/health" | python3 -m json.tool 2>/dev/null
