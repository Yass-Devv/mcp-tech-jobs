import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import { z } from "zod";

const EURES_URL =
    "https://europa.eu/eures/api/jv-searchengine/public/jv-search/search";
const ARBEITNOW_URL = "https://www.arbeitnow.com/api/job-board-api";
const MAX_JOBS = 50;
const EURES_PAGE_SIZE = 50; // maximum accepté par l'API (400 au-delà)
const EURES_PAGES_TO_SCAN = 5; // peu d'offres "selfemployed" sont tech : on élargit le vivier avant filtrage

// --- Schéma de sortie : c'est le contrat que TOUTE offre doit respecter,
// quelle que soit sa source d'origine (EURES ou Arbeitnow).
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

// --- Schémas d'entrée : uniquement les champs que l'on consomme réellement
// dans chaque réponse d'API (pas besoin de modéliser tout le payload).
const EuresJobSchema = z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    locationMap: z
        .record(z.string(), z.array(z.string().nullable()))
        .optional(),
    employer: z
        .object({ name: z.string().nullable().optional() })
        .nullable()
        .optional(),
});
const EuresResponseSchema = z.object({
    jvs: z.array(EuresJobSchema),
});

const ArbeitnowJobSchema = z.object({
    slug: z.string(),
    title: z.string(),
    company_name: z.string(),
    description: z.string(),
    location: z.string().nullable().optional(),
    url: z.string(),
    job_types: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
});
const ArbeitnowResponseSchema = z.object({
    data: z.array(ArbeitnowJobSchema),
});

// --- Filtre "tech" : ni EURES ni Arbeitnow n'exposent de filtre serveur fiable
// sur le domaine métier, donc on filtre côté client sur titre/description/tags.
//
// Deux regex distinctes : les mots-clés non ambigus (insensibles à la casse),
// et les sigles courts (IT, AI, SAP, SRE) qui ne doivent matcher qu'en
// majuscules — en insensible à la casse, "\bIT\b" matche aussi "it" au milieu
// de mots accentués comme "réitération", car en JS les lettres accentuées
// (é, è...) ne comptent pas comme caractères de mot pour \b.
const TECH_KEYWORDS =
    /d[eé]veloppeur|developer|d[eé]veloppement (logiciel|web|mobile)|software|ing[eé]nieur (logiciel|informatique|syst[eè]me|r[eé]seau)|informatique\b|devops|sysadmin|administrateur syst[eè]me|cloud|cybers[eé]curit[eé]|cybersecurity|full[- ]?stack|front[- ]?end|back[- ]?end|data (scientist|engineer|analyst|analiste)|analyste (donn[eé]es|programmeur)|machine learning|intelligence artificielle|architecte (logiciel|technique|solution)|programmeur|network engineer|qa engineer|test(eur|ing) logiciel|site reliability|blockchain|product owner|scrum master|ux\/ui|ui\/ux|robotics?|automatisation industrielle/i;

const TECH_ACRONYMS = /\b(IT|AI|SAP|SRE|SIEM|CISO|SOC)\b/;

function isTechJob(text: string): boolean {
    return TECH_KEYWORDS.test(text) || TECH_ACRONYMS.test(text);
}

// --- Source 1 : EURES, filtrée nativement côté serveur sur "selfemployed".
// L'API ne propose aucun filtre de domaine métier : on parcourt plusieurs
// pages pour constituer un vivier suffisant avant le filtre "tech" côté client.
async function fetchEuresJobs(limit: number): Promise<RawJob[]> {
    const techJobs: RawJob[] = [];

    for (let page = 1; page <= EURES_PAGES_TO_SCAN; page++) {
        try {
            const response = await axios.post(EURES_URL, {
                resultsPerPage: EURES_PAGE_SIZE,
                positionOfferingCodes: ["selfemployed"],
                page,
            });
            const { jvs } = EuresResponseSchema.parse(response.data);
            if (jvs.length === 0) break; // plus de résultats disponibles

            for (const jv of jvs) {
                if (!isTechJob(`${jv.title} ${jv.description}`)) continue;
                techJobs.push({
                    id: `eures-${jv.id}`,
                    title: jv.title.trim(),
                    company: jv.employer?.name?.trim() || "Entreprise non précisée",
                    description: jv.description,
                    location: jv.locationMap
                        ? Object.keys(jv.locationMap).join(", ")
                        : "Non précisé",
                    contract_type: "freelance",
                    source: "EURES",
                    url: `https://europa.eu/eures/portal/jv-se/jv-details/${jv.id}?lang=en`,
                });
            }

            if (techJobs.length >= limit) break;
        } catch (error) {
            console.error(
                `❌ Échec de la récupération EURES (page ${page}) :`,
                error instanceof Error ? error.message : error,
            );
            break;
        }
    }

    return techJobs;
}

// --- Source 2 : Arbeitnow, qui n'a pas de filtre serveur pour le freelance
// ni pour le domaine métier. Les deux filtres se font donc côté client.
async function fetchArbeitnowJobs(): Promise<RawJob[]> {
    try {
        const response = await axios.get(ARBEITNOW_URL);
        const { data } = ArbeitnowResponseSchema.parse(response.data);

        return data
            .filter((job) =>
                (job.job_types ?? []).some((type) =>
                    /freelance|contract/i.test(type),
                ),
            )
            .filter((job) =>
                isTechJob(
                    `${job.title} ${job.description} ${(job.tags ?? []).join(" ")}`,
                ),
            )
            .map(
                (job): RawJob => ({
                    id: `arbeitnow-${job.slug}`,
                    title: job.title.trim(),
                    company: job.company_name.trim(),
                    description: job.description,
                    location: job.location?.trim() || "Non précisé",
                    contract_type: "contract",
                    source: "Arbeitnow",
                    url: job.url,
                }),
            );
    } catch (error) {
        console.error(
            "❌ Échec de la récupération Arbeitnow :",
            error instanceof Error ? error.message : error,
        );
        return [];
    }
}

// --- Dédoublonnage : une offre est un doublon si son URL OU son titre
// normalisé a déjà été vu, peu importe la source.
function normalizeTitle(title: string): string {
    const COMBINING_DIACRITICS = new RegExp("[\\u0300-\\u036f]", "g");
    return title
        .toLowerCase()
        .normalize("NFD")
        .replace(COMBINING_DIACRITICS, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function dedupeJobs(jobs: RawJob[]): RawJob[] {
    const seenUrls = new Set<string>();
    const seenTitles = new Set<string>();
    const unique: RawJob[] = [];

    for (const job of jobs) {
        const urlKey = job.url.trim().toLowerCase();
        const titleKey = normalizeTitle(job.title);

        if (seenUrls.has(urlKey) || seenTitles.has(titleKey)) {
            continue;
        }

        seenUrls.add(urlKey);
        seenTitles.add(titleKey);
        unique.push(job);
    }

    return unique;
}

async function main(): Promise<void> {
    console.log("🔄 Récupération des offres freelance (EURES + Arbeitnow)...");

    const [euresJobs, arbeitnowJobs] = await Promise.all([
        fetchEuresJobs(MAX_JOBS),
        fetchArbeitnowJobs(),
    ]);
    console.log(
        `   EURES : ${euresJobs.length} offres | Arbeitnow : ${arbeitnowJobs.length} offres`,
    );

    const merged = dedupeJobs([...euresJobs, ...arbeitnowJobs]).slice(
        0,
        MAX_JOBS,
    );
    const validated = merged.map((job) => RawJobSchema.parse(job));

    const outputPath = path.join(process.cwd(), "data", "raw_jobs.json");
    fs.writeFileSync(outputPath, JSON.stringify(validated, null, 2), "utf-8");

    console.log(
        `✅ Succès : ${validated.length} offres uniques sauvegardées dans "data/raw_jobs.json"`,
    );
}

main();
