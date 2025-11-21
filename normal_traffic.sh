#!/bin/bash

API_URL="http://localhost:4000/api/orders/execute"

echo "Starting Realistic Traffic Simulation..."

for i in {1..30}; do
  RAND=$(($RANDOM % 10))

  if [ $RAND -lt 8 ]; then
    
    echo "[$i] Sending Valid Order..."
    curl -s -o /dev/null -X POST $API_URL \
         -H "Content-Type: application/json" \
         -d '{"inputMint":"So11111111111111111111111111111111111111112", "outputMint":"4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", "amount": 0.1}'

  elif [ $RAND -eq 8 ]; then
   
    echo "[$i] Sending Bad Request (Missing Amount)..."
    curl -s -o /dev/null -X POST $API_URL \
         -H "Content-Type: application/json" \
         -d '{"inputMint":"So11111111111111111111111111111111111111112", "outputMint":"4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"}'

  else
    
    echo "[$i] Sending Invalid Token..."
    curl -s -o /dev/null -X POST $API_URL \
         -H "Content-Type: application/json" \
         -d '{"inputMint":"FAKE_TOKEN_123", "outputMint":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "amount": 0.5}'
  fi

  SLEEP_TIME=$(awk -v min=0.1 -v max=1.5 'BEGIN{srand(); print min+rand()*(max-min)}')
  sleep $SLEEP_TIME
done

echo "Simulation Complete."