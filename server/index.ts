import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ── Load plan catalog ──────────────────────────────────────────────────────
const catalog = JSON.parse(
  fs.readFileSync(path.join(ROOT, "data", "plans.json"), "utf-8")
);
const plans: any[] = catalog.plans;
const addOnPerks: any[] = catalog.add_on_perks;
const promotions: any[] = catalog.current_promotions;

// ── Load widget HTML at startup ────────────────────────────────────────────
const planFinderHtml = fs.readFileSync(
  path.join(ROOT, "public", "plan-finder.html"),
  "utf-8"
);
const planCompareHtml = fs.readFileSync(
  path.join(ROOT, "public", "plan-compare.html"),
  "utf-8"
);

// ── Availability simulation ────────────────────────────────────────────────
function simulateAvailability(zipCode: string): string[] {
  const first = zipCode.charAt(0);
  if (first === "1") return ["fiber", "5g"];
  if (first === "7" || first === "9") return ["5g", "lte"];
  if (first === "3" || first === "4") return ["5g"];
  return ["5g", "lte"];
}

// ── MCP Server ─────────────────────────────────────────────────────────────
const server = new McpServer({
  name: "verizon-home-internet",
  version: "1.0.0",
});

// Resource: Plan Finder Widget
server.resource("plan-finder", "ui://verizon-assistant/plan-finder", {
  mimeType: "text/html;profile=mcp-app",
  description: "Verizon Plan Finder widget",
}, async () => ({
  contents: [{
    uri: "ui://verizon-assistant/plan-finder",
    mimeType: "text/html;profile=mcp-app",
    text: planFinderHtml,
  }],
}));

// Resource: Plan Compare Widget
server.resource("plan-compare", "ui://verizon-assistant/plan-compare", {
  mimeType: "text/html;profile=mcp-app",
  description: "Verizon Plan Comparison widget",
}, async () => ({
  contents: [{
    uri: "ui://verizon-assistant/plan-compare",
    mimeType: "text/html;profile=mcp-app",
    text: planCompareHtml,
  }],
}));

// ── Tool 1: check_availability ─────────────────────────────────────────────
server.tool(
  "check_availability",
  "Check which Verizon home internet services (Fios Fiber, 5G Home, LTE) are available at a given address.",
  {
    address: z.string().describe("Street address"),
    zip_code: z.string().describe("5-digit ZIP code"),
  },
  async ({ address, zip_code }) => {
    const available_types = simulateAvailability(zip_code);
    const availablePlans = plans.filter((p) =>
      available_types.includes(p.type)
    );
    const matchingPromos = promotions.filter((promo) =>
      promo.eligible_plans.some((pid: string) =>
        availablePlans.some((p) => p.id === pid)
      )
    );
    return {
      structuredContent: {
        available_types,
        address_formatted: `${address}, ${zip_code}`,
        plans: availablePlans,
        promotions: matchingPromos,
        add_on_perks: addOnPerks,
      },
      content: [
        {
          type: "text" as const,
          text: `At ${address} (${zip_code}), the following service types are available: ${available_types.join(", ")}. Found ${availablePlans.length} plans. With Auto Pay. Taxes & fees extra. Subject to credit approval.`,
        },
      ],
      _meta: {
        ui: { resourceUri: "ui://verizon-assistant/plan-finder" },
      },
    };
  }
);

// ── Tool 2: get_plans ──────────────────────────────────────────────────────
server.tool(
  "get_plans",
  "Return available Verizon home internet plans filtered by connection type, budget, or household size.",
  {
    types: z.array(z.string()).optional().describe("Filter by connection types: fiber, 5g, lte"),
    budget_max: z.number().optional().describe("Max monthly price (with mobile discount)"),
    household_size: z.number().optional().describe("Number of people in household"),
  },
  async ({ types, budget_max, household_size }) => {
    let filtered = [...plans];

    if (types && types.length > 0) {
      filtered = filtered.filter((p) => types.includes(p.type));
    }
    if (budget_max !== undefined) {
      filtered = filtered.filter((p) => p.price_with_mobile <= budget_max);
    }

    // Sort by recommendation based on household size
    if (household_size !== undefined) {
      let minSpeed = 0;
      if (household_size <= 2) minSpeed = 300;
      else if (household_size <= 5) minSpeed = 500;
      else minSpeed = 1000;

      filtered.sort((a, b) => {
        const aGood = a.download_mbps >= minSpeed ? 0 : 1;
        const bGood = b.download_mbps >= minSpeed ? 0 : 1;
        return aGood - bGood || a.price_with_mobile - b.price_with_mobile;
      });
    }

    const matchingPromos = promotions.filter((promo) =>
      promo.eligible_plans.some((pid: string) =>
        filtered.some((p) => p.id === pid)
      )
    );

    return {
      structuredContent: {
        plans: filtered,
        promotions: matchingPromos,
        add_on_perks: addOnPerks,
      },
      content: [
        {
          type: "text" as const,
          text: `Found ${filtered.length} matching plans. With Auto Pay. Taxes & fees extra. Subject to credit approval.`,
        },
      ],
      _meta: {
        ui: { resourceUri: "ui://verizon-assistant/plan-finder" },
      },
    };
  }
);

// ── Tool 3: compare_plans ──────────────────────────────────────────────────
server.tool(
  "compare_plans",
  "Return a side-by-side comparison of 2-3 selected Verizon plans.",
  {
    plan_ids: z
      .array(z.string())
      .min(2)
      .max(3)
      .describe("Array of 2-3 plan IDs to compare"),
  },
  async ({ plan_ids }) => {
    const selected = plan_ids
      .map((id) => plans.find((p) => p.id === id))
      .filter(Boolean);

    if (selected.length < 2) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Could not find enough matching plans. Valid IDs: ${plans.map((p) => p.id).join(", ")}`,
          },
        ],
      };
    }

    const comparison = {
      plans: selected,
      fields: [
        "name",
        "type",
        "download_mbps",
        "upload_mbps",
        "price_base",
        "price_with_mobile",
        "price_lock_years",
        "data_cap",
        "includes_router",
        "includes_whole_home_wifi",
        "gift_card_amount",
        "perks",
        "best_for",
      ],
    };

    return {
      structuredContent: comparison,
      content: [
        {
          type: "text" as const,
          text: `Comparing ${selected.map((p: any) => p.name).join(" vs ")}. With Auto Pay. Taxes & fees extra. Subject to credit approval.`,
        },
      ],
      _meta: {
        ui: { resourceUri: "ui://verizon-assistant/plan-compare" },
      },
    };
  }
);

// ── Tool 4: get_promotions ─────────────────────────────────────────────────
server.tool(
  "get_promotions",
  "Return current Verizon home internet promotions, optionally filtered to a specific plan.",
  {
    plan_id: z.string().optional().describe("Filter promotions for a specific plan ID"),
  },
  async ({ plan_id }) => {
    let filtered = [...promotions];
    if (plan_id) {
      filtered = filtered.filter((p) => p.eligible_plans.includes(plan_id));
    }
    return {
      structuredContent: { promotions: filtered },
      content: [
        {
          type: "text" as const,
          text: filtered.length > 0
            ? `Found ${filtered.length} current promotions:\n${filtered.map((p) => `- ${p.title}: ${p.description}`).join("\n")}`
            : "No promotions currently available for the selected plan.",
        },
      ],
    };
  }
);

// ── Tool 5: calculate_monthly_cost ─────────────────────────────────────────
server.tool(
  "calculate_monthly_cost",
  "Calculate total monthly cost for a Verizon plan including perks, mobile discount, and bundles.",
  {
    plan_id: z.string().describe("Plan ID"),
    has_verizon_mobile: z.boolean().describe("Whether the customer has Verizon mobile service"),
    selected_perks: z.array(z.string()).optional().describe("Names of selected add-on perks"),
  },
  async ({ plan_id, has_verizon_mobile, selected_perks }) => {
    const plan = plans.find((p) => p.id === plan_id);
    if (!plan) {
      return {
        content: [{ type: "text" as const, text: `Plan '${plan_id}' not found.` }],
      };
    }

    const basePrice = has_verizon_mobile
      ? plan.price_with_mobile
      : plan.price_base;
    const mobileDiscount = has_verizon_mobile
      ? plan.price_base - plan.price_with_mobile
      : 0;

    let perkCosts: { name: string; price: number }[] = [];
    if (selected_perks && selected_perks.length > 0) {
      // First perk may be free for eligible plans
      const freePerkCount = plan.perks.some((p: string) =>
        p.includes("perk on us")
      )
        ? 1
        : 0;

      selected_perks.forEach((perkName, idx) => {
        const perk = addOnPerks.find((p) => p.name === perkName);
        if (perk) {
          const isFree = idx < freePerkCount;
          perkCosts.push({
            name: perk.name,
            price: isFree ? 0 : perk.price,
          });
        }
      });
    }

    const totalPerkCost = perkCosts.reduce((sum, p) => sum + p.price, 0);
    const totalMonthly = basePrice + totalPerkCost;
    const firstYearSavings = mobileDiscount * 12;

    const result = {
      plan_name: plan.name,
      base_price: plan.price_base,
      mobile_discount: mobileDiscount,
      price_after_discount: basePrice,
      perk_costs: perkCosts,
      total_perk_cost: totalPerkCost,
      total_monthly: totalMonthly,
      price_lock_years: plan.price_lock_years,
      first_year_savings: firstYearSavings,
      gift_card_amount: plan.gift_card_amount,
    };

    return {
      structuredContent: result,
      content: [
        {
          type: "text" as const,
          text: `${plan.name}: $${totalMonthly.toFixed(2)}/mo${has_verizon_mobile ? ` (saving $${mobileDiscount.toFixed(2)}/mo with Verizon Mobile)` : ""}${perkCosts.length > 0 ? ` including ${perkCosts.length} perk(s)` : ""}. Price locked for ${plan.price_lock_years} years. With Auto Pay. Taxes & fees extra. Subject to credit approval.`,
        },
      ],
    };
  }
);

// ── Tool 6: start_order ────────────────────────────────────────────────────
server.tool(
  "start_order",
  "Generate an order summary and a deep link to verizon.com to complete the purchase. This does NOT process payment.",
  {
    plan_id: z.string().describe("Plan ID to order"),
    address: z.string().describe("Service address"),
    zip_code: z.string().describe("ZIP code"),
    has_verizon_mobile: z.boolean().describe("Has Verizon mobile service"),
    selected_perks: z.array(z.string()).optional().describe("Selected add-on perks"),
  },
  async ({ plan_id, address, zip_code, has_verizon_mobile, selected_perks }) => {
    const plan = plans.find((p) => p.id === plan_id);
    if (!plan) {
      return {
        content: [{ type: "text" as const, text: `Plan '${plan_id}' not found.` }],
      };
    }

    const basePrice = has_verizon_mobile
      ? plan.price_with_mobile
      : plan.price_base;

    let perkTotal = 0;
    const freePerkCount = plan.perks.some((p: string) =>
      p.includes("perk on us")
    )
      ? 1
      : 0;
    const perkDetails: { name: string; price: number }[] = [];
    if (selected_perks) {
      selected_perks.forEach((perkName, idx) => {
        const perk = addOnPerks.find((p) => p.name === perkName);
        if (perk) {
          const isFree = idx < freePerkCount;
          const price = isFree ? 0 : perk.price;
          perkDetails.push({ name: perk.name, price });
          perkTotal += price;
        }
      });
    }

    const totalMonthly = basePrice + perkTotal;
    const checkoutUrl = `https://www.verizon.com/home/internet/?plan=${encodeURIComponent(plan_id)}&zip=${encodeURIComponent(zip_code)}`;

    const matchingPromos = promotions.filter((p) =>
      p.eligible_plans.includes(plan_id)
    );

    const orderSummary = {
      plan: plan.name,
      type: plan.type,
      speed: `${plan.download_mbps} Mbps download${plan.upload_mbps ? ` / ${plan.upload_mbps} Mbps upload` : ""}`,
      address: `${address}, ${zip_code}`,
      monthly_total: totalMonthly,
      price_breakdown: {
        base_price: plan.price_base,
        mobile_discount: has_verizon_mobile
          ? plan.price_base - plan.price_with_mobile
          : 0,
        perks: perkDetails,
      },
      price_lock_years: plan.price_lock_years,
      gift_card: plan.gift_card_amount > 0
        ? `$${plan.gift_card_amount} Amazon Gift Card`
        : null,
      promotions: matchingPromos.map((p) => p.title),
      includes: [
        plan.includes_router ? "Router included" : null,
        plan.includes_whole_home_wifi ? "Whole-Home Wi-Fi included" : null,
        "No annual contract",
        plan.data_cap === null ? "No data caps" : null,
      ].filter(Boolean),
    };

    return {
      structuredContent: {
        order_summary: orderSummary,
        checkout_url: checkoutUrl,
        disclaimers: [
          "With Auto Pay + paper-free billing. Taxes & fees extra.",
          "Subject to credit approval and address verification.",
          "Equipment charges may apply. See verizon.com for full terms.",
          "Gift card offer requires new internet line. Allow 8 weeks for delivery.",
          "Promotional pricing subject to change. Check verizon.com for current offers.",
        ],
      },
      content: [
        {
          type: "text" as const,
          text: `Order summary for ${plan.name} at ${address}, ${zip_code}:\n- Monthly total: $${totalMonthly.toFixed(2)}/mo\n- Speed: ${orderSummary.speed}\n\nComplete your order at: ${checkoutUrl}\n\nWith Auto Pay. Taxes & fees extra. Subject to credit approval.`,
        },
      ],
      _meta: {
        ui: { resourceUri: "ui://verizon-assistant/plan-finder" },
      },
    };
  }
);

// ── Express + Transport ────────────────────────────────────────────────────
const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

app.use(
  cors({
    origin: [
      "https://chatgpt.com",
      "https://chat.openai.com",
      "http://localhost:3000",
    ],
    credentials: true,
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "MCP-Protocol-Version",
      "mcp-protocol-version",
    ],
    methods: ["GET", "POST", "OPTIONS", "DELETE"],
  })
);

app.use(express.json());

// Health check
app.get("/", (_req, res) => {
  res.json({ status: "ok", app: "Verizon Home Internet Assistant" });
});

// Domain verification for OpenAI
app.get("/.well-known/openai-apps", (_req, res) => {
  res.type("text/plain").send("tFY_ZjmS5o2O_YtKpgDCFfOmI9hJVtTqjGqv-jVcmKo");
});

// Serve static widget files
app.use("/public", express.static(path.join(ROOT, "public")));

// MCP Streamable HTTP transport
const transports = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
    return;
  }

  // New session
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });

  transport.onclose = () => {
    const sid = (transport as any).sessionId;
    if (sid) transports.delete(sid);
  };

  await server.connect(transport);

  const sid = (transport as any).sessionId;
  if (sid) transports.set(sid, transport);

  await transport.handleRequest(req, res);
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
    return;
  }
  // For new SSE connections without a session, create one
  const accept = req.headers.accept || "";
  if (accept.includes("text/event-stream")) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    transport.onclose = () => {
      const sid = (transport as any).sessionId;
      if (sid) transports.delete(sid);
    };
    await server.connect(transport);
    const sid = (transport as any).sessionId;
    if (sid) transports.set(sid, transport);
    await transport.handleRequest(req, res);
    return;
  }
  res.status(400).json({ error: "No session. Send a POST to /mcp first." });
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
    return;
  }
  res.status(400).json({ error: "No session found." });
});

app.listen(PORT, () => {
  console.log(`Verizon Home Internet MCP Server running on http://localhost:${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`Health check: http://localhost:${PORT}/`);
});
