import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const DATA_PATH = path.join(process.cwd(), "data", "structured_jobs.json");
const PORT = Number(process.env.PORT) || 3000;

const StructuredJobSchema = z.object({
  id: z.string(),
  title: z.string(),
  company: z.string(),
  description: z.string(),
  location: z.string(),
  contract_type: z.enum(["freelance", "contract"]),
  source: z.enum(["EURES", "Arbeitnow"]),
  url: z.string().url(),
  skills: z.array(z.string()),
  seniority: z.enum(["junior", "confirmé", "senior", "non précisé"]),
  work_mode: z.enum(["remote", "hybride", "sur site", "non précisé"]),
  salary_range: z.string().nullable(),
  category: z.string(),
  summary: z.string(),
});
type StructuredJob = z.infer<typeof StructuredJobSchema>;

function loadJobs(): StructuredJob[] {
  if (!fs.existsSync(DATA_PATH)) {
    throw new Error(
      `"data/structured_jobs.json" introuvable. Lancez d'abord "npm run fetch" puis "npm run structure".`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
  return z.array(StructuredJobSchema).parse(raw);
}

function matchesQuery(job: StructuredJob, query: string): boolean {
  const needle = query.toLowerCase();
  return (
    job.title.toLowerCase().includes(needle) ||
    job.company.toLowerCase().includes(needle) ||
    job.category.toLowerCase().includes(needle) ||
    job.skills.some((skill) => skill.toLowerCase().includes(needle))
  );
}

function toSummaryView(job: StructuredJob) {
  const { description, ...summary } = job;
  return summary;
}

function createServer(): McpServer {
  const server = new McpServer({
    name: "freelance-jobs-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "search_jobs",
    {
      title: "Rechercher des offres freelance",
      description:
        "Recherche des offres d'emploi freelance/contract collectées depuis EURES et Arbeitnow, et enrichies par IA (compétences, séniorité, mode de travail, catégorie).",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            "Mot-clé recherché dans le titre, l'entreprise, la catégorie ou les compétences",
          ),
        category: z.string().optional().describe("Filtre exact sur la catégorie"),
        seniority: z
          .enum(["junior", "confirmé", "senior", "non précisé"])
          .optional(),
        work_mode: z
          .enum(["remote", "hybride", "sur site", "non précisé"])
          .optional(),
        contract_type: z.enum(["freelance", "contract"]).optional(),
        limit: z.number().int().positive().max(50).optional().default(20),
      },
    },
    async ({ query, category, seniority, work_mode, contract_type, limit }) => {
      const jobs = loadJobs();

      const filtered = jobs.filter((job) => {
        if (query && !matchesQuery(job, query)) return false;
        if (category && job.category.toLowerCase() !== category.toLowerCase())
          return false;
        if (seniority && job.seniority !== seniority) return false;
        if (work_mode && job.work_mode !== work_mode) return false;
        if (contract_type && job.contract_type !== contract_type) return false;
        return true;
      });

      const results = filtered.slice(0, limit).map(toSummaryView);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { total_matches: filtered.length, results },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_job",
    {
      title: "Obtenir le détail d'une offre",
      description:
        "Retourne les informations complètes (dont la description brute) d'une offre freelance par son identifiant.",
      inputSchema: {
        id: z.string().describe("Identifiant de l'offre (champ 'id' retourné par search_jobs)"),
      },
    },
    async ({ id }) => {
      const jobs = loadJobs();
      const job = jobs.find((j) => j.id === id);

      if (!job) {
        return {
          content: [
            { type: "text", text: `Aucune offre trouvée pour l'id "${id}".` },
          ],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(job, null, 2) }],
      };
    },
  );

  return server;
}

const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.status(200).send("MCP freelance-jobs server is running. Endpoint: POST /mcp");
});

app.post("/mcp", async (req, res) => {
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Erreur MCP :", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. Server is stateless (no SSE stream)." },
    id: null,
  });
});

app.delete("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. Server is stateless (no session to delete)." },
    id: null,
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Serveur MCP démarré sur le port ${PORT} (endpoint POST /mcp)`);
});