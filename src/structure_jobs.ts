import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import OpenAI from "openai";
import { z } from "zod";

const MODEL = "gpt-4o-mini";
const CONCURRENCY = 5;
const MAX_DESCRIPTION_CHARS = 4000;

const RawJobSchema = z.object({
    id: z.string(),
    title: z.string(),
    company: z.string(),
    description: z.string(),
    location: z.string(),
    contract_type: z.enum(["freelance", "contract"]),
    source: z.enum(["EURES", "Arbeitnow"]),
    url: z.string().url(),
});
type RawJob = z.infer<typeof RawJobSchema>;

// Schéma attendu par le projet
const EnrichmentSchema = z.object({
    skills: z.array(z.string()),
    seniority: z.enum(["junior", "confirmé", "senior", "non précisé"]),
    work_mode: z.enum(["remote", "hybride", "sur site", "non précisé"]),
    salary_range: z.string().nullable(),
    category: z.string(),
    summary: z.string(),
});
type Enrichment = z.infer<typeof EnrichmentSchema>;

const StructuredJobSchema = RawJobSchema.extend(EnrichmentSchema.shape);
type StructuredJob = z.infer<typeof StructuredJobSchema>;

// Initialise le client OpenAI (lit automatiquement OPENAI_API_KEY dans le .env)
const client = new OpenAI();

// Schéma JSON Strict pour OpenAI
const JSON_OUTPUT_SCHEMA = {
    name: "job_enrichment",
    strict: true,
    schema: {
        type: "object",
        properties: {
            skills: {
                type: "array",
                items: { type: "string" },
                description:
                    "Compétences ou technologies requises (ex: 'React', 'TypeScript', 'comptabilité'). Liste vide si aucune.",
            },
            seniority: {
                type: "string",
                enum: ["junior", "confirmé", "senior", "non précisé"],
            },
            work_mode: {
                type: "string",
                enum: ["remote", "hybride", "sur site", "non précisé"],
            },
            salary_range: {
                type: ["string", "null"],
                description:
                    "Rémunération mentionnée (ex: '450€/jour'), ou null si non précisée.",
            },
            category: {
                type: "string",
                description:
                    "Domaine métier en 1 ou 2 mots (ex: 'Développement', 'DevOps', 'Data').",
            },
            summary: {
                type: "string",
                description:
                    "Résumé neutre de l'offre en 2 phrases maximum, en français.",
            },
        },
        required: [
            "skills",
            "seniority",
            "work_mode",
            "salary_range",
            "category",
            "summary",
        ],
        additionalProperties: false,
    },
};

function stripHtml(html: string): string {
    return html
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

async function enrichJob(job: RawJob): Promise<Enrichment> {
    const cleanDescription = stripHtml(job.description).slice(
        0,
        MAX_DESCRIPTION_CHARS,
    );

    const response = await client.chat.completions.create({
        model: MODEL,
        response_format: {
            type: "json_schema",
            json_schema: JSON_OUTPUT_SCHEMA,
        },
        messages: [
            {
                role: "system",
                content:
                    "Tu es un assistant spécialisé dans l'analyse et l'extraction de données structurées pour des offres d'emploi freelance.",
            },
            {
                role: "user",
                content: `Extrais les informations structurées de cette offre :\n\nTitre : ${job.title}\nEntreprise : ${job.company}\nLocalisation : ${job.location}\nDescription : ${cleanDescription}`,
            },
        ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
        throw new Error(`Aucune réponse reçue pour l'offre ${job.id}`);
    }

    const parsed = JSON.parse(content);
    return EnrichmentSchema.parse(parsed);
}

async function enrichAll(jobs: RawJob[]): Promise<StructuredJob[]> {
    const results: StructuredJob[] = [];

    for (let i = 0; i < jobs.length; i += CONCURRENCY) {
        const batch = jobs.slice(i, i + CONCURRENCY);
        console.log(
            `   Traitement des offres ${i + 1} à ${Math.min(i + CONCURRENCY, jobs.length)} / ${jobs.length}...`,
        );

        const settled = await Promise.allSettled(
            batch.map(async (job) => {
                const enrichment = await enrichJob(job);
                return StructuredJobSchema.parse({ ...job, ...enrichment });
            }),
        );

        for (const [index, outcome] of settled.entries()) {
            if (outcome.status === "fulfilled") {
                results.push(outcome.value);
            } else {
                console.error(
                    `❌ Échec d'enrichissement pour "${batch[index].title}" :`,
                    outcome.reason instanceof Error
                        ? outcome.reason.message
                        : outcome.reason,
                );
            }
        }
    }

    return results;
}

async function main(): Promise<void> {
    const inputPath = path.join(process.cwd(), "data", "raw_jobs.json");
    const outputPath = path.join(process.cwd(), "data", "structured_jobs.json");

    const rawData = JSON.parse(fs.readFileSync(inputPath, "utf-8"));
    const jobs = z.array(RawJobSchema).parse(rawData);

    console.log(`🔄 Structuration de ${jobs.length} offres via ${MODEL}...`);

    const structured = await enrichAll(jobs);
    fs.writeFileSync(outputPath, JSON.stringify(structured, null, 2), "utf-8");

    console.log(
        `✅ Succès : ${structured.length}/${jobs.length} offres structurées et sauvegardées dans "data/structured_jobs.json"`,
    );
}

main();
