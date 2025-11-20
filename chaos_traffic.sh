#!/bin/bash

API_URL="http://localhost:4000/api/orders/execute"
WRONG_URL="http://localhost:4000/wrong-endpoint"

echo "Starting Chaos Traffic Generator..."
echo "Target: $API_URL"
echo "Watch your Grafana dashboard now!"

for ((i=1; i<=50; i++)); do
  
  RAND=$((RANDOM % 10))

  # --- SCENARIO 1: BURST MODE (10% chance) ---
  # Simulates multiple users clicking "Buy" at the same exact second
  if [ $RAND -eq 0 ]; then
    echo "   [BURST] Firing 5 rapid requests..."
    for b in {1..5}; do
      curl -s -o /dev/null -X POST $API_URL \
           -H "Content-Type: application/json" \
           -d '{"inputMint":"So111...BURST", "outputMint":"EPjFW...USDC", "amount": 0.5}' &
    done
    wait 
    echo "      Burst complete."

  # --- SCENARIO 2: THE GOOD TRADES (60% chance) ---
  elif [ $RAND -lt 7 ]; then
    echo "[$i] Valid Trade (200 OK)"
    curl -s -o /dev/null -X POST $API_URL \
         -H "Content-Type: application/json" \
         -d '{"inputMint":"So11111111111111111111111111111111111111112", "outputMint":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "amount": 0.1}'

  # --- SCENARIO 3: THE CLUMSY USER (10% chance) ---
  # Missing 'amount' field -> 400 Bad Request
  elif [ $RAND -eq 7 ]; then
    echo "[$i] Bad Request: Missing Field (400)"
    curl -s -o /dev/null -X POST $API_URL \
         -H "Content-Type: application/json" \
         -d '{"inputMint":"So111...MISSING", "outputMint":"EPjFW...USDC"}'

  # --- SCENARIO 4: THE LOST TOURIST (10% chance) ---
  # Wrong URL -> 404 Not Found
  elif [ $RAND -eq 8 ]; then
    echo "[$i] 404 Not Found"
    curl -s -o /dev/null -X POST $WRONG_URL \
         -H "Content-Type: application/json" \
         -d '{"amount": 100}'

  # --- SCENARIO 5: THE WRONG METHOD (10% chance) ---
  # Sending GET instead of POST -> 404 or 405
  else
    echo "[$i] Wrong Method (GET)"
    curl -s -o /dev/null -X GET $API_URL
  fi

  # Random sleep between 0.1s and 0.8s for organic jitter
  SLEEP_TIME=$(awk -v min=0.1 -v max=0.8 'BEGIN{srand(); print min+rand()*(max-min)}')
  sleep $SLEEP_TIME

done

echo "Chaos Simulation Complete."