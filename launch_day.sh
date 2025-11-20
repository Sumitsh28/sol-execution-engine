#!/bin/bash

API_URL="http://localhost:4000/api/orders/execute"

echo "Simulating Token Launch Day..."
echo "Phase 1: Pre-Launch (Quiet Traffic)..."

# PHASE 1: Low Traffic (10 orders, slow)
for i in {1..5}; do
  curl -s -o /dev/null -X POST $API_URL \
       -H "Content-Type: application/json" \
       -d '{"inputMint":"So111...PRE", "outputMint":"EPjFW...USDC", "amount": 0.1}'
  echo "   ☕ Early bird order $i"
  sleep 1.5
done

echo "------------------------------------------------"
echo "Phase 2: TOKEN LAUNCHED! (FOMO SPIKE)"
echo "------------------------------------------------"

# PHASE 2: The Spike (30 orders, AS FAST AS POSSIBLE)
# We use '&' to send requests in parallel (Multi-threading simulation)
for i in {1..30}; do
  curl -s -o /dev/null -X POST $API_URL \
       -H "Content-Type: application/json" \
       -d '{"inputMint":"So111...FOMO", "outputMint":"EPjFW...USDC", "amount": 100}' & 
  
  echo "   BUY! BUY! BUY! Order $i"
  
  sleep 0.05
done

wait 

echo "------------------------------------------------"
echo "Phase 3: Network Congestion (Simulating Failures)"
echo "------------------------------------------------"

# PHASE 3: The Error Wave (10 Bad Requests)
for i in {1..10}; do
  curl -s -o /dev/null -X POST $API_URL \
       -H "Content-Type: application/json" \
       -d '{"BROKEN_DATA": "true"}'
  
  echo "   Transaction Failed (Network Busy) $i"
  sleep 0.2
done

echo "------------------------------------------------"
echo "Phase 4: Market Stabilization"
echo "------------------------------------------------"

# PHASE 4: Normal Trading (10 orders, random interval)
for i in {1..10}; do
  curl -s -o /dev/null -X POST $API_URL \
       -H "Content-Type: application/json" \
       -d '{"inputMint":"So111...STABLE", "outputMint":"EPjFW...USDC", "amount": 1.5}'
  
  echo "   Stable Trade $i"
  sleep 0.8
done

echo "Simulation Complete. Check your Dashboard!"