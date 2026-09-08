import * as fs from "fs";
import * as path from "path";
import express from "express";

const TEMPLATE_PATH = path.join(process.cwd(), "public", "index.html");
const DATA_PATH = path.join(process.cwd(), "data", "structured_jobs.json");
const RAW_DATA_PATH = path.join(process.cwd(), "data", "raw_jobs.json");
const PORT = Number(process.env.WEB_PORT) || 3100;

function renderPage(): string {
    const dataPath = fs.existsSync(DATA_PATH) ? DATA_PATH : RAW_DATA_PATH;
    if (!fs.existsSync(dataPath)) {
        throw new Error(
            `Aucune donnée trouvée. Lancez d'abord "npm run fetch" (et idéalement "npm run structure").`,
        );
    }

    const jobs = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
    const template = fs.readFileSync(TEMPLATE_PATH, "utf-8");

    // Échappe "<" pour empêcher toute donnée (ex: description HTML d'une offre)
    // de fermer prématurément la balise <script> dans laquelle le JSON est injecté.
    const jobsJson = JSON.stringify(jobs).replace(/</g, "\\u003c");

    return template
        .replaceAll("%%JOBS_JSON%%", () => jobsJson)
        .replaceAll("%%JOBS_COUNT%%", String(jobs.length));
}

const app = express();

app.get("/", (_req, res) => {
    try {
        res.type("html").send(renderPage());
    } catch (error) {
        res
            .status(500)
            .type("text/plain")
            .send(error instanceof Error ? error.message : String(error));
    }
});

app.listen(PORT, () => {
    console.log(`🌐 Site local démarré sur http://localhost:${PORT}`);
});
