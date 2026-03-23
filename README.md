# Verizon Home Internet Assistant

A ChatGPT App (MCP Server) that helps customers discover Verizon home internet plans, compare options, calculate costs, and start orders.

## Quick Start

```bash
npm install
npm start
# Server runs at http://localhost:3000
```

## Connect to ChatGPT

1. Start the server: `npm start`
2. Expose via ngrok: `ngrok http 3000`
3. In ChatGPT: **Settings > Connectors > Create**
   - Name: `Verizon Home Internet Assistant`
   - URL: `https://<subdomain>.ngrok.app/mcp`
   - Auth: None

## MCP Tools

| Tool | Description |
|------|-------------|
| `check_availability` | Check service types available at an address (simulated by ZIP) |
| `get_plans` | List plans filtered by type, budget, or household size |
| `compare_plans` | Side-by-side comparison of 2-3 plans |
| `get_promotions` | Current promotions, optionally per plan |
| `calculate_monthly_cost` | Full cost breakdown with perks and mobile discount |
| `start_order` | Generate order summary + deep link to verizon.com |

## Test Prompts

- "What Verizon internet is available at 123 Main St, Brooklyn, NY 11201?"
- "I have a family of 4 and budget of $60/month. What do you recommend?"
- "Compare Fios 1 Gig vs 5G Home Ultimate side by side."
- "What promotions are running right now?"
- "I want Fios 1 Gig with Netflix and Disney+. What's my total cost? I have Verizon mobile."
- "Start my order for Fios 1 Gig at my address."

## Project Structure

```
server/index.ts          - MCP server with 6 tools + Express transport
public/plan-finder.html  - Main widget (plan cards, calculator, checkout)
public/plan-compare.html - Comparison table widget
data/plans.json          - Plan catalog (editable)
```

## Availability Simulation

ZIP codes determine available service types:
- Starts with **1** (Northeast): Fiber + 5G
- Starts with **7, 9** (TX, CA, West): 5G + LTE
- Starts with **3, 4** (Southeast, Midwest): 5G only
- All others: 5G + LTE
