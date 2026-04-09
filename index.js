import "dotenv/config";
import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const API_KEY = process.env.GHL_API_KEY;
const LOCATION_API_KEY = process.env.GHL_LOCATION_API_KEY;
const BASE_URL =
  process.env.GHL_API_BASE_URL || "https://services.leadconnectorhq.com";
const PORT = process.env.PORT || 3000;
const MCP_SECRET = process.env.MCP_SECRET; // optional bearer token for security

const DATAIKU_HOST = process.env.DATAIKU_HOST; // e.g. https://dss.example.com
const DATAIKU_API_KEY = process.env.DATAIKU_API_KEY;

if (!API_KEY) {
  console.error("Error: GHL_API_KEY environment variable is not set.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// GHL API client helpers
// ---------------------------------------------------------------------------

async function ghlRequest(method, path, body, apiKey = API_KEY) {
  const url = `${BASE_URL}${path}`;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Version: "2021-07-28",
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    throw new Error(`GHL API error ${res.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

const ghl = {
  get: (path) => ghlRequest("GET", path),
  post: (path, body) => ghlRequest("POST", path, body),
  put: (path, body) => ghlRequest("PUT", path, body),
  locationGet: (path) =>
    ghlRequest("GET", path, undefined, LOCATION_API_KEY || API_KEY),
  locationPost: (path, body) =>
    ghlRequest("POST", path, body, LOCATION_API_KEY || API_KEY),
};

// ---------------------------------------------------------------------------
// Dataiku DSS API client helper
// ---------------------------------------------------------------------------

async function dataikuRequest(method, path) {
  if (!DATAIKU_HOST || !DATAIKU_API_KEY) {
    throw new Error(
      "Dataiku DSS is not configured. Set DATAIKU_HOST and DATAIKU_API_KEY environment variables."
    );
  }

  const url = `${DATAIKU_HOST.replace(/\/+$/, "")}/public/api${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${DATAIKU_API_KEY}`,
      "Content-Type": "application/json",
    },
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    throw new Error(`Dataiku API error ${res.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const tools = [
  {
    name: "get_sub_accounts",
    description:
      "List all sub-accounts (locations) under the agency. Returns id, name, address, and other metadata for each location.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description:
            "Maximum number of results to return (default 10, max 100)",
        },
        skip: {
          type: "number",
          description: "Number of results to skip for pagination (default 0)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_contacts",
    description:
      "Get contacts for a specific sub-account (location). Returns a list of contacts with their details.",
    inputSchema: {
      type: "object",
      properties: {
        locationId: {
          type: "string",
          description: "The sub-account / location ID to fetch contacts from",
        },
        limit: {
          type: "number",
          description:
            "Maximum number of contacts to return (default 20, max 100)",
        },
        query: {
          type: "string",
          description:
            "Search query to filter contacts by name, email, or phone",
        },
      },
      required: ["locationId"],
    },
  },
  {
    name: "create_contact",
    description: "Create a new contact inside a sub-account (location).",
    inputSchema: {
      type: "object",
      properties: {
        locationId: {
          type: "string",
          description:
            "The sub-account / location ID where the contact will be created",
        },
        firstName: { type: "string", description: "Contact's first name" },
        lastName: { type: "string", description: "Contact's last name" },
        email: { type: "string", description: "Contact's email address" },
        phone: { type: "string", description: "Contact's phone number" },
        address1: { type: "string", description: "Street address" },
        city: { type: "string", description: "City" },
        state: { type: "string", description: "State / province" },
        country: { type: "string", description: "Country code (e.g. US)" },
        postalCode: { type: "string", description: "ZIP / postal code" },
        website: { type: "string", description: "Website URL" },
        companyName: {
          type: "string",
          description: "Company the contact belongs to",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags to apply to the contact",
        },
        source: {
          type: "string",
          description: "Lead source (e.g. 'API', 'Website', 'Referral')",
        },
      },
      required: ["locationId"],
    },
  },
  {
    name: "get_conversations",
    description:
      "Get a list of conversations for a location. Returns conversation IDs, contact info, last message, and unread counts.",
    inputSchema: {
      type: "object",
      properties: {
        locationId: {
          type: "string",
          description:
            "The sub-account / location ID to fetch conversations for",
        },
        limit: {
          type: "number",
          description:
            "Maximum number of conversations to return (default 20, max 100)",
        },
        query: {
          type: "string",
          description: "Search query to filter conversations",
        },
      },
      required: ["locationId"],
    },
  },
  {
    name: "send_message",
    description:
      "Send an SMS or Email message to a contact in an existing conversation.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: {
          type: "string",
          description: "The conversation ID to send the message in",
        },
        type: {
          type: "string",
          enum: ["SMS", "Email"],
          description: "The type of message to send: SMS or Email",
        },
        message: {
          type: "string",
          description: "The message body / content to send",
        },
      },
      required: ["conversationId", "type", "message"],
    },
  },
  {
    name: "create_api_key",
    description:
      "Create an API key for a specific sub-account (location). Returns the newly created key details.",
    inputSchema: {
      type: "object",
      properties: {
        locationId: {
          type: "string",
          description:
            "The sub-account / location ID to create the API key for",
        },
        name: {
          type: "string",
          description: "A label / name for this API key",
        },
      },
      required: ["locationId", "name"],
    },
  },
  {
    name: "get_billing_charges",
    description:
      "Get agency wallet charges/transactions from the GHL billing system. Returns raw charge records which may include locationId, amount, type, and date.",
    inputSchema: {
      type: "object",
      properties: {
        startDate: {
          type: "string",
          description:
            "Start date for filtering charges (ISO 8601, e.g. 2026-01-01)",
        },
        endDate: {
          type: "string",
          description:
            "End date for filtering charges (ISO 8601, e.g. 2026-12-31)",
        },
        locationId: {
          type: "string",
          description:
            "Optional: filter charges for a specific sub-account location ID",
        },
        limit: {
          type: "number",
          description: "Number of results to return (default 100, max 100)",
        },
        skip: {
          type: "number",
          description: "Number of results to skip for pagination (default 0)",
        },
      },
      required: [],
    },
  },
  {
    name: "list_dataiku_projects",
    description:
      "List all projects available on the connected Dataiku DSS instance. Returns project key, name, owner, description, and other metadata for each project.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

const GetSubAccountsInput = z.object({
  limit: z.number().optional().default(10),
  skip: z.number().optional().default(0),
});

const GetContactsInput = z.object({
  locationId: z.string(),
  limit: z.number().optional().default(20),
  query: z.string().optional(),
});

const CreateContactInput = z.object({
  locationId: z.string(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  address1: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  postalCode: z.string().optional(),
  website: z.string().optional(),
  companyName: z.string().optional(),
  tags: z.array(z.string()).optional(),
  source: z.string().optional(),
});

const GetConversationsInput = z.object({
  locationId: z.string(),
  limit: z.number().optional().default(20),
  query: z.string().optional(),
});

const SendMessageInput = z.object({
  conversationId: z.string(),
  type: z.enum(["SMS", "Email"]),
  message: z.string(),
});

const CreateApiKeyInput = z.object({
  locationId: z.string(),
  name: z.string(),
});

const GetBillingChargesInput = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  locationId: z.string().optional(),
  limit: z.number().optional().default(100),
  skip: z.number().optional().default(0),
});

async function handleGetSubAccounts(args) {
  const { limit, skip } = GetSubAccountsInput.parse(args);
  const params = new URLSearchParams({ limit, skip });
  const data = await ghl.get(`/locations/search?${params}`);
  return JSON.stringify(data, null, 2);
}

async function handleGetContacts(args) {
  const { locationId, limit, query } = GetContactsInput.parse(args);
  let path = `/contacts/?locationId=${encodeURIComponent(locationId)}&limit=${limit}`;
  if (query) path += `&query=${encodeURIComponent(query)}`;
  const data = await ghl.locationGet(path);
  return JSON.stringify(data, null, 2);
}

async function handleCreateContact(args) {
  const { locationId, ...rest } = CreateContactInput.parse(args);
  const body = { locationId };
  const fields = [
    "firstName", "lastName", "email", "phone", "address1",
    "city", "state", "country", "postalCode", "website",
    "companyName", "tags", "source",
  ];
  for (const field of fields) {
    if (rest[field] !== undefined) body[field] = rest[field];
  }
  const data = await ghl.locationPost("/contacts/", body);
  return JSON.stringify(data, null, 2);
}

async function handleGetConversations(args) {
  const { locationId, limit, query } = GetConversationsInput.parse(args);
  let path = `/conversations/search?locationId=${encodeURIComponent(locationId)}&limit=${limit}`;
  if (query) path += `&query=${encodeURIComponent(query)}`;
  const data = await ghl.locationGet(path);
  return JSON.stringify(data, null, 2);
}

async function handleSendMessage(args) {
  const { conversationId, type, message } = SendMessageInput.parse(args);
  const body = { conversationId, type, message };
  const data = await ghl.locationPost("/conversations/messages", body);
  return JSON.stringify(data, null, 2);
}

async function handleCreateApiKey(args) {
  const { locationId, name } = CreateApiKeyInput.parse(args);
  const data = await ghl.post(
    `/locations/${encodeURIComponent(locationId)}/apiKeys`,
    { name }
  );
  return JSON.stringify(data, null, 2);
}

async function handleGetBillingCharges(args) {
  const { startDate, endDate, locationId, limit, skip } =
    GetBillingChargesInput.parse(args);

  let companyId = null;
  try {
    const whoami = await ghl.get("/oauth/installedLocations");
    companyId = whoami?.companyId || whoami?.data?.companyId || null;
  } catch {}

  if (!companyId) {
    try {
      const loc = await ghl.get("/locations/search?limit=1");
      companyId = loc?.locations?.[0]?.companyId || null;
    } catch {}
  }

  const params = new URLSearchParams({ limit, skip });
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  if (locationId) params.set("locationId", locationId);

  const endpoints = [
    companyId ? `/companies/${companyId}/wallet/transactions` : null,
    companyId ? `/companies/${companyId}/billing/transactions` : null,
    companyId
      ? `/saas-api/public-api/get-transactions?companyId=${companyId}`
      : null,
    `/lc-phone/transactions`,
    `/reporting/revenue`,
  ].filter(Boolean);

  const results = { companyId, endpoints: {} };
  for (const endpoint of endpoints) {
    try {
      const data = await ghl.get(
        endpoint.includes("?")
          ? `${endpoint}&${params}`
          : `${endpoint}?${params}`
      );
      results.endpoints[endpoint] = { success: true, data };
    } catch (err) {
      results.endpoints[endpoint] = { success: false, error: err.message };
    }
  }
  return JSON.stringify(results, null, 2);
}

async function handleListDataikuProjects() {
  const data = await dataikuRequest("GET", "/projects/");
  return JSON.stringify(data, null, 2);
}

const handlers = {
  get_sub_accounts: handleGetSubAccounts,
  get_contacts: handleGetContacts,
  create_contact: handleCreateContact,
  get_conversations: handleGetConversations,
  send_message: handleSendMessage,
  create_api_key: handleCreateApiKey,
  get_billing_charges: handleGetBillingCharges,
  list_dataiku_projects: handleListDataikuProjects,
};

// ---------------------------------------------------------------------------
// MCP server factory (one per request for stateless operation)
// ---------------------------------------------------------------------------

function createMcpServer() {
  const server = new Server(
    { name: "automate-south-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = handlers[name];
    if (!handler) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
    try {
      const result = await handler(args ?? {});
      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Express HTTP server
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// Optional bearer token auth
app.use((req, res, next) => {
  if (!MCP_SECRET) return next();
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${MCP_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", name: "automate-south-mcp" });
});

// MCP endpoint
app.post("/mcp", async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () => {
  console.log(`Automate South MCP server listening on port ${PORT}`);
});
