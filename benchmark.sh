#!/bin/bash
HOST="${1:-http://localhost:3033}"
API_KEY="${API_KEY:?Set API_KEY env var}"
TOTAL=10
PAYLOAD='{"messages":[{"role":"user","content":"Say hello in one word"}]}'
now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }

echo "=== Benchmark ($TOTAL sequential requests) ==="
echo "Host: $HOST"
echo ""

total_ms=0
for i in $(seq 1 $TOTAL); do
  start=$(now_ms)
  status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$HOST/v1/chat/completions" \
    -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" -d "$PAYLOAD")
  end=$(now_ms); elapsed=$((end - start)); total_ms=$((total_ms + elapsed))
  echo "  #$i: ${elapsed}ms (HTTP $status)"
done

avg=$((total_ms / TOTAL))
echo ""
echo "Total: ${total_ms}ms | Avg: ${avg}ms"
